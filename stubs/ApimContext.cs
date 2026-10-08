// Stubs for the Azure API Management policy expression environment.
//
// These describe the implicit `context` variable and the helper methods available in
// @(...) and @{...} expressions, so the C# language server can offer completion, hover and
// type checking. They are paraphrased from the policy expressions reference
// (https://learn.microsoft.com/azure/api-management/api-management-policy-expressions).
// Microsoft only documents a few of these interface names; the rest are named here by the
// access path they describe (context.Request -> IRequest, and so on).
//
// Nothing here runs: every member is abstract or throws.

#pragma warning disable CS1591

using System;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

namespace Apim.Policies
{
    /// <summary>The request context available to every policy expression as <c>context</c>.</summary>
    public interface IProxyRequestContext
    {
        /// <summary>The API that matched the request.</summary>
        IApi Api { get; }

        /// <summary>The backend entity serving the request.</summary>
        IBackend Backend { get; }

        /// <summary>The API Management service and gateway handling the request.</summary>
        IDeployment Deployment { get; }

        /// <summary>Time elapsed since <see cref="Timestamp"/>.</summary>
        TimeSpan Elapsed { get; }

        /// <summary>GraphQL resolver data (arguments and parent object).</summary>
        IGraphQL GraphQL { get; }

        /// <summary>The most recent error, populated in the on-error section.</summary>
        ILastError LastError { get; }

        /// <summary>The API operation that matched the request.</summary>
        IOperation Operation { get; }

        /// <summary>The product the subscription belongs to.</summary>
        IProduct Product { get; }

        /// <summary>The incoming request.</summary>
        IRequest Request { get; }

        /// <summary>Unique identifier of this request.</summary>
        Guid RequestId { get; }

        /// <summary>The response being returned to the caller.</summary>
        IResponse Response { get; }

        /// <summary>The subscription used to make the call.</summary>
        ISubscription Subscription { get; }

        /// <summary>When the gateway received the request.</summary>
        DateTime Timestamp { get; }

        /// <summary>Whether request tracing is enabled.</summary>
        bool Tracing { get; }

        /// <summary>The user tied to the subscription, if any.</summary>
        IUser User { get; }

        /// <summary>Variables set earlier by set-variable and other policies.</summary>
        IReadOnlyDictionary<string, object> Variables { get; }

        /// <summary>The workspace that owns the API.</summary>
        IWorkspace Workspace { get; }

        /// <summary>Writes a message to the request trace.</summary>
        void Trace(string message);
    }

    /// <summary>Information about an API.</summary>
    public interface IApi
    {
        /// <summary>API identifier.</summary>
        string Id { get; }

        /// <summary>API display name.</summary>
        string Name { get; }

        /// <summary>API URL suffix.</summary>
        string Path { get; }

        /// <summary>Protocols the API accepts (http, https, ws, wss).</summary>
        IEnumerable<string> Protocols { get; }

        /// <summary>Backend service URL.</summary>
        IUrl ServiceUrl { get; }

        /// <summary>Custom names of the subscription key header and query parameter.</summary>
        ISubscriptionKeyParameterNames SubscriptionKeyParameterNames { get; }

        /// <summary>Whether this is the current API revision.</summary>
        bool IsCurrentRevision { get; }

        /// <summary>API revision identifier.</summary>
        string Revision { get; }

        /// <summary>API version.</summary>
        string Version { get; }
    }

    /// <summary>Names of the subscription key header and query parameter.</summary>
    public interface ISubscriptionKeyParameterNames
    {
        /// <summary>Header that carries the subscription key.</summary>
        string Header { get; }

        /// <summary>Query parameter that carries the subscription key.</summary>
        string Query { get; }
    }

    /// <summary>Kind of backend entity.</summary>
    public enum BackendType
    {
        /// <summary>A single backend.</summary>
        Single,

        /// <summary>A load-balanced pool of backends.</summary>
        Pool,
    }

    /// <summary>The backend serving the request.</summary>
    public interface IBackend
    {
        /// <summary>Azure region of the backend.</summary>
        string AzureRegion { get; }

        /// <summary>Backend entity identifier.</summary>
        string Id { get; }

        /// <summary>Whether this is a single backend or a pool.</summary>
        BackendType Type { get; }
    }

    /// <summary>The API Management service and gateway handling the request.</summary>
    public interface IDeployment
    {
        /// <summary>The gateway handling the request.</summary>
        IGateway Gateway { get; }

        /// <summary>Gateway identifier; "managed" for managed gateways.</summary>
        string GatewayId { get; }

        /// <summary>Region of the gateway.</summary>
        string Region { get; }

        /// <summary>API Management service identifier.</summary>
        string ServiceId { get; }

        /// <summary>API Management service name.</summary>
        string ServiceName { get; }

        /// <summary>Carbon intensity information for the gateway's region.</summary>
        ISustainabilityInfo SustainabilityInfo { get; }

        /// <summary>Service certificates keyed by id or thumbprint.</summary>
        IReadOnlyDictionary<string, X509Certificate2> Certificates { get; }
    }

    /// <summary>The gateway handling the request.</summary>
    public interface IGateway
    {
        /// <summary>Gateway identifier; "managed" for managed gateways.</summary>
        string Id { get; }

        /// <summary>Gateway instance identifier; "managed" for managed gateways.</summary>
        string InstanceId { get; }

        /// <summary>True for the managed gateway.</summary>
        bool IsManaged { get; }
    }

    /// <summary>Regional carbon intensity level.</summary>
    public enum CarbonIntensityCategory
    {
        /// <summary>Not known.</summary>
        NotAvailable,

        /// <summary>Very low carbon intensity.</summary>
        VeryLow,

        /// <summary>Low carbon intensity.</summary>
        Low,

        /// <summary>Medium carbon intensity.</summary>
        Medium,

        /// <summary>High carbon intensity.</summary>
        High,

        /// <summary>Very high carbon intensity.</summary>
        VeryHigh,
    }

    /// <summary>Carbon intensity information.</summary>
    public interface ISustainabilityInfo
    {
        /// <summary>Current carbon intensity level of the region.</summary>
        CarbonIntensityCategory CurrentCarbonIntensity { get; }
    }

    /// <summary>GraphQL resolver data.</summary>
    public interface IGraphQL
    {
        /// <summary>Arguments passed to the resolved field.</summary>
        IGraphQLDataObject GraphQLArguments { get; }

        /// <summary>Parent object of the resolved field.</summary>
        IGraphQLDataObject Parent { get; }
    }

    /// <summary>A GraphQL value. Its members aren't documented.</summary>
    public interface IGraphQLDataObject
    {
    }

    /// <summary>The most recent error.</summary>
    public interface ILastError
    {
        /// <summary>Policy or element that raised the error.</summary>
        string Source { get; }

        /// <summary>Machine-friendly error reason.</summary>
        string Reason { get; }

        /// <summary>Human-readable error description.</summary>
        string Message { get; }

        /// <summary>Scope where the error happened.</summary>
        string Scope { get; }

        /// <summary>Policy section where the error happened.</summary>
        string Section { get; }

        /// <summary>Path of the failing element inside the policy.</summary>
        string Path { get; }

        /// <summary>Value of the failing policy's id attribute.</summary>
        string PolicyId { get; }
    }

    /// <summary>The API operation that matched the request.</summary>
    public interface IOperation
    {
        /// <summary>Operation identifier.</summary>
        string Id { get; }

        /// <summary>HTTP method of the operation.</summary>
        string Method { get; }

        /// <summary>Operation display name.</summary>
        string Name { get; }

        /// <summary>Operation URL template.</summary>
        string UrlTemplate { get; }
    }

    /// <summary>Publication state of a product.</summary>
    public enum ProductState
    {
        /// <summary>Not published.</summary>
        NotPublished,

        /// <summary>Published.</summary>
        Published,
    }

    /// <summary>A product.</summary>
    public interface IProduct
    {
        /// <summary>Whether subscriptions need administrator approval.</summary>
        bool ApprovalRequired { get; }

        /// <summary>Groups that can access the product.</summary>
        IEnumerable<IGroup> Groups { get; }

        /// <summary>Product identifier.</summary>
        string Id { get; }

        /// <summary>Product display name.</summary>
        string Name { get; }

        /// <summary>Whether the product is published.</summary>
        ProductState State { get; }

        /// <summary>Maximum subscriptions per user, if limited.</summary>
        int? SubscriptionsLimit { get; }

        /// <summary>Whether calls need a subscription key.</summary>
        bool SubscriptionRequired { get; }
    }

    /// <summary>A user group.</summary>
    public interface IGroup
    {
        /// <summary>Group identifier.</summary>
        string Id { get; }

        /// <summary>Group display name.</summary>
        string Name { get; }
    }

    /// <summary>The incoming request.</summary>
    public interface IRequest
    {
        /// <summary>Request body, or null when there isn't one.</summary>
        IMessageBody Body { get; }

        /// <summary>Client certificate presented with the request.</summary>
        X509Certificate2 Certificate { get; }

        /// <summary>Microsoft Foundry information for the request.</summary>
        IFoundry Foundry { get; }

        /// <summary>Request headers. Names are case-insensitive.</summary>
        IReadOnlyDictionary<string, string[]> Headers { get; }

        /// <summary>Caller's IP address.</summary>
        string IpAddress { get; }

        /// <summary>URL template parameters matched from the request URL.</summary>
        IReadOnlyDictionary<string, string> MatchedParameters { get; }

        /// <summary>HTTP method.</summary>
        string Method { get; }

        /// <summary>URL as received, before any rewrite.</summary>
        IUrl OriginalUrl { get; }

        /// <summary>Current request URL, after any rewrite.</summary>
        IUrl Url { get; }

        /// <summary>Private endpoint the request came through, or null.</summary>
        IPrivateEndpointConnection PrivateEndpointConnection { get; }
    }

    /// <summary>Microsoft Foundry information.</summary>
    public interface IFoundry
    {
        /// <summary>Foundry model deployment for the request.</summary>
        string Deployment { get; }
    }

    /// <summary>The private endpoint connection a request arrived through.</summary>
    public interface IPrivateEndpointConnection
    {
        /// <summary>Connection name.</summary>
        string Name { get; }

        /// <summary>Private link group id.</summary>
        string GroupId { get; }

        /// <summary>Private link member name.</summary>
        string MemberName { get; }
    }

    /// <summary>The response returned to the caller.</summary>
    public interface IResponse
    {
        /// <summary>Response body.</summary>
        IMessageBody Body { get; }

        /// <summary>Response headers. Names are case-insensitive.</summary>
        IReadOnlyDictionary<string, string[]> Headers { get; }

        /// <summary>HTTP status code.</summary>
        int StatusCode { get; }

        /// <summary>HTTP reason phrase.</summary>
        string StatusReason { get; }
    }

    /// <summary>A request or response body.</summary>
    public interface IMessageBody
    {
        /// <summary>
        /// Reads the body as <typeparamref name="T"/>: string, byte[], JObject, JToken, JArray,
        /// XNode, XElement or XDocument. Consumes the body unless <paramref name="preserveContent"/> is true.
        /// </summary>
        T As<T>(bool preserveContent = false);

        /// <summary>
        /// Parses a URL-encoded form body. Consumes the body unless <paramref name="preserveContent"/> is true.
        /// </summary>
        IDictionary<string, IList<string>> AsFormUrlEncodedContent(bool preserveContent = false);
    }

    /// <summary>A URL.</summary>
    public interface IUrl
    {
        /// <summary>Host name.</summary>
        string Host { get; }

        /// <summary>Path.</summary>
        string Path { get; }

        /// <summary>Port number.</summary>
        int Port { get; }

        /// <summary>Query parameters.</summary>
        IReadOnlyDictionary<string, string[]> Query { get; }

        /// <summary>Raw query string.</summary>
        string QueryString { get; }

        /// <summary>Scheme, http or https.</summary>
        string Scheme { get; }
    }

    /// <summary>The caller's subscription.</summary>
    public interface ISubscription
    {
        /// <summary>When the subscription was created.</summary>
        DateTime CreatedDate { get; }

        /// <summary>When the subscription expires, if set.</summary>
        DateTime? EndDate { get; }

        /// <summary>Subscription identifier.</summary>
        string Id { get; }

        /// <summary>Key used to make this call.</summary>
        string Key { get; }

        /// <summary>Subscription display name.</summary>
        string Name { get; }

        /// <summary>Primary subscription key.</summary>
        string PrimaryKey { get; }

        /// <summary>Secondary subscription key.</summary>
        string SecondaryKey { get; }

        /// <summary>When the subscription became active, if set.</summary>
        DateTime? StartDate { get; }
    }

    /// <summary>A developer portal user.</summary>
    public interface IUser
    {
        /// <summary>Email address.</summary>
        string Email { get; }

        /// <summary>First name.</summary>
        string FirstName { get; }

        /// <summary>Groups the user belongs to.</summary>
        IEnumerable<IGroup> Groups { get; }

        /// <summary>User identifier.</summary>
        string Id { get; }

        /// <summary>Linked identity provider accounts.</summary>
        IEnumerable<IUserIdentity> Identities { get; }

        /// <summary>Last name.</summary>
        string LastName { get; }

        /// <summary>Administrator's note about the user.</summary>
        string Note { get; }

        /// <summary>When the user registered.</summary>
        DateTime RegistrationDate { get; }
    }

    /// <summary>An identity provider account linked to a user.</summary>
    public interface IUserIdentity
    {
        /// <summary>User's id at the provider.</summary>
        string Id { get; }

        /// <summary>Identity provider name.</summary>
        string Provider { get; }
    }

    /// <summary>The workspace that owns the API.</summary>
    public interface IWorkspace
    {
        /// <summary>Workspace identifier.</summary>
        string Id { get; }

        /// <summary>Workspace name.</summary>
        string Name { get; }
    }

    /// <summary>Decoded credentials from a Basic authorization header.</summary>
    public sealed class BasicAuthCredentials
    {
        private BasicAuthCredentials() => throw null;

        /// <summary>Decoded password.</summary>
        public string Password => throw null;

        /// <summary>Decoded user name.</summary>
        public string UserId => throw null;
    }

    /// <summary>A parsed JSON Web Token.</summary>
    public sealed class Jwt
    {
        private Jwt() => throw null;

        /// <summary>Signing algorithm (alg).</summary>
        public string Algorithm => throw null;

        /// <summary>Audiences (aud).</summary>
        public IEnumerable<string> Audiences => throw null;

        /// <summary>All claims, by claim name.</summary>
        public IReadOnlyDictionary<string, string[]> Claims => throw null;

        /// <summary>Expiry time (exp).</summary>
        public DateTime? ExpirationTime => throw null;

        /// <summary>Token id (jti).</summary>
        public string Id => throw null;

        /// <summary>Issuer (iss).</summary>
        public string Issuer => throw null;

        /// <summary>Issue time (iat).</summary>
        public DateTime? IssuedAt => throw null;

        /// <summary>Not-before time (nbf).</summary>
        public DateTime? NotBefore => throw null;

        /// <summary>Subject (sub).</summary>
        public string Subject => throw null;

        /// <summary>Token type header (typ).</summary>
        public string Type => throw null;
    }

    /// <summary>Helper methods APIM adds to policy expressions.</summary>
    public static class PolicyExtensions
    {
        /// <summary>
        /// Values for <paramref name="name"/> joined with commas, or <paramref name="defaultValue"/>
        /// if missing. Works on headers, query parameters and JWT claims.
        /// </summary>
        public static string GetValueOrDefault(this IReadOnlyDictionary<string, string[]> source, string name, string defaultValue) => throw null;

        /// <summary>
        /// Values for <paramref name="name"/> joined with commas, or null if missing.
        /// </summary>
        public static string GetValueOrDefault(this IReadOnlyDictionary<string, string[]> source, string name) => throw null;

        /// <summary>
        /// The variable cast to <typeparamref name="T"/>, or <paramref name="defaultValue"/> if it
        /// isn't set. Throws if the stored value isn't a <typeparamref name="T"/>.
        /// </summary>
        public static T GetValueOrDefault<T>(this IReadOnlyDictionary<string, object> variables, string name, T defaultValue) => throw null;

        /// <summary>
        /// The variable cast to <typeparamref name="T"/>, or default(T) if it isn't set. Throws
        /// if the stored value isn't a <typeparamref name="T"/>.
        /// </summary>
        public static T GetValueOrDefault<T>(this IReadOnlyDictionary<string, object> variables, string name) => throw null;

        /// <summary>Parses a Basic authorization header value; null if it isn't valid.</summary>
        public static BasicAuthCredentials AsBasic(this string input) => throw null;

        /// <summary>Tries to parse a Basic authorization header value.</summary>
        public static bool TryParseBasic(this string input, out BasicAuthCredentials result) => throw null;

        /// <summary>Parses a JWT; null if it isn't valid. Doesn't validate the signature.</summary>
        public static Jwt AsJwt(this string input) => throw null;

        /// <summary>Tries to parse a JWT. Doesn't validate the signature.</summary>
        public static bool TryParseJwt(this string input, out Jwt result) => throw null;

        /// <summary>Encrypts with a named symmetric algorithm, key and IV.</summary>
        public static byte[] Encrypt(this byte[] input, string alg, byte[] key, byte[] iv) => throw null;

        /// <summary>Encrypts with a configured symmetric algorithm.</summary>
        public static byte[] Encrypt(this byte[] input, SymmetricAlgorithm alg) => throw null;

        /// <summary>Encrypts with a symmetric algorithm and an explicit key and IV.</summary>
        public static byte[] Encrypt(this byte[] input, SymmetricAlgorithm alg, byte[] key, byte[] iv) => throw null;

        /// <summary>Decrypts with a named symmetric algorithm, key and IV.</summary>
        public static byte[] Decrypt(this byte[] input, string alg, byte[] key, byte[] iv) => throw null;

        /// <summary>Decrypts with a configured symmetric algorithm.</summary>
        public static byte[] Decrypt(this byte[] input, SymmetricAlgorithm alg) => throw null;

        /// <summary>Decrypts with a symmetric algorithm and an explicit key and IV.</summary>
        public static byte[] Decrypt(this byte[] input, SymmetricAlgorithm alg, byte[] key, byte[] iv) => throw null;

        /// <summary>Validates the certificate chain without checking revocation.</summary>
        public static bool VerifyNoRevocation(this X509Certificate2 input) => throw null;

        /// <summary>Formats a parsed form body as a query string.</summary>
        public static string ToQueryString(this IDictionary<string, IList<string>> form) => throw null;

        /// <summary>Formats a parsed form body as URL-encoded content.</summary>
        public static string ToFormUrlEncodedContent(this IDictionary<string, IList<string>> form) => throw null;
    }

    /// <summary>Named values substituted into the policy before it's compiled.</summary>
    public static class NamedValues
    {
        /// <summary>The named value <paramref name="name"/>, written as {{name}} in the policy.</summary>
        public static string Get(string name) => throw null;
    }
}
