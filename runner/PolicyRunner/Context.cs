// The context interfaces from ApimContext.cs, implemented over a run's state. Policies change the
// state through the members here that aren't on the interfaces; expressions only see the interfaces.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Net;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Xml.Linq;
using Apim.Policies;
using Newtonsoft.Json.Linq;

namespace PolicyRunner
{
    /// <summary>Headers or query parameters: names ignore case (query ones don't), and each holds a list of values.</summary>
    public sealed class Multimap : IReadOnlyDictionary<string, string[]>
    {
        private readonly Dictionary<string, string[]> map;
        private readonly List<string> order = new List<string>();

        public Multimap(bool ignoreCase, IEnumerable<KeyValuePair<string, string[]>>? from = null)
        {
            map = new Dictionary<string, string[]>(ignoreCase ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal);
            if (from != null)
            {
                foreach (var kv in from) Set(kv.Key, kv.Value);
            }
        }

        public void Set(string name, string[] values)
        {
            if (!map.ContainsKey(name)) order.Add(name);
            map[name] = values;
        }

        public void Append(string name, IEnumerable<string> values) => Set(name, (map.TryGetValue(name, out var old) ? old : Array.Empty<string>()).Concat(values).ToArray());

        public void Remove(string name)
        {
            if (map.Remove(name)) order.RemoveAll(n => map.Comparer.Equals(n, name));
        }

        public Multimap Clone() => new Multimap(map.Comparer == StringComparer.OrdinalIgnoreCase, this);

        public string[] this[string key] => map[key];
        public IEnumerable<string> Keys => order;
        public IEnumerable<string[]> Values => order.Select(k => map[k]);
        public int Count => map.Count;
        public bool ContainsKey(string key) => map.ContainsKey(key);
        public bool TryGetValue(string key, out string[] value) => map.TryGetValue(key, out value!);
        public IEnumerator<KeyValuePair<string, string[]>> GetEnumerator() => order.Select(k => new KeyValuePair<string, string[]>(k, map[k])).GetEnumerator();
        System.Collections.IEnumerator System.Collections.IEnumerable.GetEnumerator() => GetEnumerator();

        public Dictionary<string, string[]> ToDictionary() => order.ToDictionary(k => k, k => map[k]);
    }

    public sealed class Url : IUrl
    {
        public Url(string url)
        {
            var u = new Uri(url, UriKind.Absolute);
            Scheme = u.Scheme;
            Host = u.Host;
            Port = u.Port;
            Path = Uri.UnescapeDataString(u.AbsolutePath);
            QueryParams = ParseQuery(u.Query);
        }

        private Url(Url other)
        {
            Scheme = other.Scheme;
            Host = other.Host;
            Port = other.Port;
            Path = other.Path;
            QueryParams = other.QueryParams.Clone();
        }

        public string Scheme { get; set; }
        public string Host { get; set; }
        public int Port { get; set; }
        public string Path { get; set; }
        public Multimap QueryParams { get; private set; }
        public IReadOnlyDictionary<string, string[]> Query => QueryParams;

        /// <summary>With its leading '?', or empty when there's no query.</summary>
        public string QueryString =>
            QueryParams.Count == 0 ? "" : "?" + string.Join("&", QueryParams.SelectMany(kv => kv.Value.Select(v => Uri.EscapeDataString(kv.Key) + "=" + Uri.EscapeDataString(v))));

        public Url Clone() => new Url(this);

        public void SetQuery(Multimap query) => QueryParams = query;

        public override string ToString()
        {
            var defaultPort = (Scheme == "https" && Port == 443) || (Scheme == "http" && Port == 80);
            var path = string.Join("/", Path.Split('/').Select(Uri.EscapeDataString));
            return $"{Scheme}://{Host}{(defaultPort ? "" : ":" + Port)}{path}{QueryString}";
        }

        public static Multimap ParseQuery(string query)
        {
            var map = new Multimap(ignoreCase: false);
            foreach (var part in query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
            {
                var eq = part.IndexOf('=');
                var name = WebUtility.UrlDecode(eq < 0 ? part : part.Substring(0, eq));
                var value = eq < 0 ? "" : WebUtility.UrlDecode(part.Substring(eq + 1));
                map.Append(name, new[] { value });
            }
            return map;
        }
    }

    /// <summary>
    /// A message body. Reading it without <c>preserveContent</c> consumes it, as on the gateway, where the
    /// stream is read once: later reads, and what's forwarded, see an empty body.
    /// </summary>
    public sealed class MessageBody : IMessageBody
    {
        public MessageBody(string? content)
        {
            Content = content;
        }

        /// <summary>The text, or null once consumed or when there's none.</summary>
        public string? Content { get; private set; }

        public T As<T>(bool preserveContent = false)
        {
            var text = Content ?? "";
            if (!preserveContent) Content = null;
            var t = typeof(T);
            if (t == typeof(string)) return (T)(object)text;
            if (t == typeof(byte[])) return (T)(object)Encoding.UTF8.GetBytes(text);
            if (text.Length == 0 && (typeof(JToken).IsAssignableFrom(t) || typeof(XNode).IsAssignableFrom(t))) return default!;
            if (t == typeof(JObject)) return (T)(object)JObject.Parse(text);
            if (t == typeof(JArray)) return (T)(object)JArray.Parse(text);
            if (t == typeof(JToken)) return (T)(object)JToken.Parse(text);
            if (t == typeof(XDocument)) return (T)(object)XDocument.Parse(text);
            if (t == typeof(XElement) || t == typeof(XNode)) return (T)(object)XElement.Parse(text);
            throw new InvalidOperationException($"A body can't be read as {t.Name}.");
        }

        public IDictionary<string, IList<string>> AsFormUrlEncodedContent(bool preserveContent = false)
        {
            var form = new Dictionary<string, IList<string>>();
            foreach (var kv in Url.ParseQuery(As<string>(preserveContent))) form[kv.Key] = kv.Value.ToList();
            return form;
        }
    }

    public sealed class Request : IRequest
    {
        public Request(RequestInput input)
        {
            Method = input.Method;
            OriginalUrl = new Url(input.Url);
            Url = new Url(input.BackendUrl ?? input.Url);
            HeaderMap = new Multimap(ignoreCase: true, input.Headers);
            Body = new MessageBody(input.Body);
            IpAddress = input.IpAddress;
            MatchedParameters = new Dictionary<string, string>(input.MatchedParameters, StringComparer.OrdinalIgnoreCase);
        }

        public string Method { get; set; }
        public Url Url { get; set; }
        IUrl IRequest.Url => Url;
        public Url OriginalUrl { get; }
        IUrl IRequest.OriginalUrl => OriginalUrl;
        public Multimap HeaderMap { get; }
        public IReadOnlyDictionary<string, string[]> Headers => HeaderMap;
        public MessageBody Body { get; set; }
        IMessageBody IRequest.Body => Body;
        public string IpAddress { get; }
        public IReadOnlyDictionary<string, string> MatchedParameters { get; }
        public X509Certificate2 Certificate => null!;
        public IFoundry Foundry => null!;
        public IPrivateEndpointConnection PrivateEndpointConnection => null!;
    }

    public sealed class Response : IResponse
    {
        public Response(int status = 200, string? reason = null, IEnumerable<KeyValuePair<string, string[]>>? headers = null, string? body = null)
        {
            StatusCode = status;
            StatusReason = reason ?? ReasonFor(status);
            HeaderMap = new Multimap(ignoreCase: true, headers);
            Body = new MessageBody(body);
        }

        public int StatusCode { get; set; }
        public string StatusReason { get; set; }
        public Multimap HeaderMap { get; }
        public IReadOnlyDictionary<string, string[]> Headers => HeaderMap;
        public MessageBody Body { get; set; }
        IMessageBody IResponse.Body => Body;

        public static string ReasonFor(int status)
        {
            var name = ((HttpStatusCode)status).ToString();
            if (int.TryParse(name, out _)) return "";
            var sb = new StringBuilder();
            foreach (var c in name)
            {
                if (char.IsUpper(c) && sb.Length > 0) sb.Append(' ');
                sb.Append(c);
            }
            return sb.ToString();
        }
    }

    public sealed class LastError : ILastError
    {
        public string Source { get; set; } = "";
        public string Reason { get; set; } = "";
        public string Message { get; set; } = "";
        public string Scope { get; set; } = "";
        public string Section { get; set; } = "";
        public string Path { get; set; } = "";
        public string PolicyId { get; set; } = "";
    }

    internal sealed class Api : IApi
    {
        public Api(ApiInput input, string serviceUrl)
        {
            Id = input.Id;
            Name = input.Name;
            Path = input.Path;
            ServiceUrl = new Url(serviceUrl);
            Revision = input.Revision ?? "1";
            Version = input.Version!;
        }

        public string Id { get; }
        public string Name { get; }
        public string Path { get; }
        public IEnumerable<string> Protocols => new[] { "https" };
        public IUrl ServiceUrl { get; }
        public ISubscriptionKeyParameterNames SubscriptionKeyParameterNames => new KeyNames();
        public bool IsCurrentRevision => true;
        public string Revision { get; }
        public string Version { get; }

        private sealed class KeyNames : ISubscriptionKeyParameterNames
        {
            public string Header => "Ocp-Apim-Subscription-Key";
            public string Query => "subscription-key";
        }
    }

    internal sealed class Operation : IOperation
    {
        public Operation(OperationInput input, string method)
        {
            Id = input.Id;
            Name = input.Name;
            Method = input.Method ?? method;
            UrlTemplate = input.UrlTemplate;
        }

        public string Id { get; }
        public string Method { get; }
        public string Name { get; }
        public string UrlTemplate { get; }
    }

    internal sealed class Group : IGroup
    {
        public Group(NamedInput input)
        {
            Id = input.Id;
            Name = input.Name;
        }

        public string Id { get; }
        public string Name { get; }
    }

    internal sealed class Product : IProduct
    {
        public Product(NamedInput input)
        {
            Id = input.Id;
            Name = input.Name;
        }

        public bool ApprovalRequired => false;
        public IEnumerable<IGroup> Groups => Array.Empty<IGroup>();
        public string Id { get; }
        public string Name { get; }
        public ProductState State => ProductState.Published;
        public int? SubscriptionsLimit => null;
        public bool SubscriptionRequired => true;
    }

    internal sealed class Subscription : ISubscription
    {
        public Subscription(SubscriptionInput input, DateTime now)
        {
            Id = input.Id;
            Name = input.Name;
            Key = input.Key;
            CreatedDate = now.Date;
        }

        public DateTime CreatedDate { get; }
        public DateTime? EndDate => null;
        public string Id { get; }
        public string Key { get; }
        public string Name { get; }
        public string PrimaryKey => Key;
        public string SecondaryKey => Key + "-secondary";
        public DateTime? StartDate => null;
    }

    internal sealed class User : IUser
    {
        public User(UserInput input, DateTime now)
        {
            Id = input.Id;
            Email = input.Email;
            FirstName = input.FirstName;
            LastName = input.LastName;
            Groups = input.Groups.Select(g => (IGroup)new Group(g)).ToList();
            RegistrationDate = now.Date;
        }

        public string Email { get; }
        public string FirstName { get; }
        public IEnumerable<IGroup> Groups { get; }
        public string Id { get; }
        public IEnumerable<IUserIdentity> Identities => Array.Empty<IUserIdentity>();
        public string LastName { get; }
        public string Note => null!;
        public DateTime RegistrationDate { get; }
    }

    internal sealed class Deployment : IDeployment
    {
        public Deployment(ContextInput input)
        {
            Region = input.Region;
            ServiceName = input.ServiceName;
        }

        public IGateway Gateway => new ManagedGateway();
        public string GatewayId => "managed";
        public string Region { get; }
        public string ServiceId => $"/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/test/providers/Microsoft.ApiManagement/service/{ServiceName}";
        public string ServiceName { get; }
        public ISustainabilityInfo SustainabilityInfo => new Sustainability();
        public IReadOnlyDictionary<string, X509Certificate2> Certificates => new Dictionary<string, X509Certificate2>();

        private sealed class ManagedGateway : IGateway
        {
            public string Id => "managed";
            public string InstanceId => "test";
            public bool IsManaged => true;
        }

        private sealed class Sustainability : ISustainabilityInfo
        {
            public CarbonIntensityCategory CurrentCarbonIntensity => CarbonIntensityCategory.NotAvailable;
        }
    }

    /// <summary><c>context</c> for one run.</summary>
    public sealed class Context : IProxyRequestContext
    {
        private readonly Stopwatch clock = Stopwatch.StartNew();
        private readonly Action<string> trace;

        public Context(RunInput input, Action<string> trace)
        {
            this.trace = trace;
            var c = input.Context;
            Timestamp = c.Timestamp ?? DateTime.UtcNow;
            RequestId = c.RequestId ?? Guid.NewGuid();
            Request = new Request(input.Request);
            Api = new Api(c.Api, c.Api.ServiceUrl ?? input.Request.BackendUrl ?? input.Request.Url);
            Operation = new Operation(c.Operation, input.Request.Method);
            Product = c.Product == null ? null! : new Product(c.Product);
            Subscription = c.Subscription == null ? null! : new Subscription(c.Subscription, Timestamp);
            User = c.User == null ? null! : new User(c.User, Timestamp);
            Deployment = new Deployment(c);
        }

        public Dictionary<string, object?> VariableMap { get; } = new Dictionary<string, object?>(StringComparer.Ordinal);
        public IReadOnlyDictionary<string, object> Variables => VariableMap!;
        public Request Request { get; }
        IRequest IProxyRequestContext.Request => Request;
        public Response? Response { get; set; }
        IResponse IProxyRequestContext.Response => Response!;
        public LastError? LastErrorValue { get; set; }
        public ILastError LastError => LastErrorValue!;
        public IApi Api { get; }
        public IBackend Backend => null!;
        public IDeployment Deployment { get; }
        public TimeSpan Elapsed => clock.Elapsed;
        public IGraphQL GraphQL => null!;
        public IOperation Operation { get; }
        public IProduct Product { get; }
        public Guid RequestId { get; }
        public ISubscription Subscription { get; }
        public DateTime Timestamp { get; }
        public bool Tracing => true;
        public IUser User { get; }
        public IWorkspace Workspace => null!;

        public void Trace(string message) => trace(message);
    }
}
