// Working versions of the helper classes ApimContext.cs declares with throw-null bodies (inside
// #if !APIM_RUNNER there). Same namespace and signatures, so expressions bind to these.

using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Threading;
using Newtonsoft.Json.Linq;

namespace Apim.Policies
{
    public sealed class BasicAuthCredentials
    {
        internal BasicAuthCredentials(string userId, string password)
        {
            UserId = userId;
            Password = password;
        }

        public string Password { get; }
        public string UserId { get; }
    }

    public sealed class Authorization
    {
        internal Authorization(string accessToken, IReadOnlyDictionary<string, object> claims)
        {
            AccessToken = accessToken;
            Claims = claims;
        }

        public string AccessToken { get; }
        public IReadOnlyDictionary<string, object> Claims { get; }
    }

    public sealed class Jwt
    {
        private Jwt(JObject header, JObject payload)
        {
            Algorithm = (string?)header["alg"] ?? "";
            Type = (string?)header["typ"] ?? "";
            var claims = new Dictionary<string, string[]>(StringComparer.Ordinal);
            foreach (var p in payload.Properties())
            {
                claims[p.Name] = p.Value is JArray a ? a.Select(Text).ToArray() : new[] { Text(p.Value) };
            }
            Claims = claims;
            Audiences = claims.TryGetValue("aud", out var aud) ? aud : Array.Empty<string>();
            Id = First("jti");
            Issuer = First("iss");
            Subject = First("sub");
            ExpirationTime = Time(payload["exp"]);
            IssuedAt = Time(payload["iat"]);
            NotBefore = Time(payload["nbf"]);

            string First(string name) => claims.TryGetValue(name, out var v) && v.Length > 0 ? v[0] : null!;
        }

        public string Algorithm { get; }
        public IEnumerable<string> Audiences { get; }
        public IReadOnlyDictionary<string, string[]> Claims { get; }
        public DateTime? ExpirationTime { get; }
        public string Id { get; }
        public string Issuer { get; }
        public DateTime? IssuedAt { get; }
        public DateTime? NotBefore { get; }
        public string Subject { get; }
        public string Type { get; }

        internal static Jwt? Parse(string? input)
        {
            if (string.IsNullOrWhiteSpace(input)) return null;
            var token = input.Trim();
            if (token.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase)) token = token.Substring(7).Trim();
            var parts = token.Split('.');
            if (parts.Length != 3) return null;
            try
            {
                var header = JObject.Parse(Encoding.UTF8.GetString(Base64Url(parts[0])));
                var payload = JObject.Parse(Encoding.UTF8.GetString(Base64Url(parts[1])));
                return new Jwt(header, payload);
            }
            catch (Exception e) when (e is FormatException || e is Newtonsoft.Json.JsonException)
            {
                return null;
            }
        }

        private static byte[] Base64Url(string s)
        {
            var b = s.Replace('-', '+').Replace('_', '/');
            return Convert.FromBase64String(b.PadRight(b.Length + (4 - b.Length % 4) % 4, '='));
        }

        private static string Text(JToken t) => t.Type == JTokenType.String ? (string)t! : t.ToString(Newtonsoft.Json.Formatting.None);

        private static DateTime? Time(JToken? t) =>
            t != null && (t.Type == JTokenType.Integer || t.Type == JTokenType.Float) ? DateTimeOffset.FromUnixTimeSeconds((long)(double)t).UtcDateTime : (DateTime?)null;
    }

    public static class PolicyExtensions
    {
        public static string GetValueOrDefault(this IReadOnlyDictionary<string, string[]> source, string name, string defaultValue) =>
            source != null && source.TryGetValue(name, out var v) && v != null ? string.Join(",", v) : defaultValue;

        public static string GetValueOrDefault(this IReadOnlyDictionary<string, string[]> source, string name) => GetValueOrDefault(source, name, null!);

        public static string GetValueOrDefault(this IReadOnlyDictionary<string, string> source, string name, string defaultValue) =>
            source != null && source.TryGetValue(name, out var v) ? v : defaultValue;

        public static string GetValueOrDefault(this IReadOnlyDictionary<string, string> source, string name) => GetValueOrDefault(source, name, null!);

        public static T GetValueOrDefault<T>(this IReadOnlyDictionary<string, object> variables, string name, T defaultValue) =>
            variables != null && variables.TryGetValue(name, out var v) ? (T)v : defaultValue;

        public static object GetValueOrDefault(this IReadOnlyDictionary<string, object> variables, string name) =>
            variables != null && variables.TryGetValue(name, out var v) ? v : null!;

        public static T GetValueOrDefault<T>(this IReadOnlyDictionary<string, object> variables, string name) => GetValueOrDefault(variables, name, default(T)!);

        public static BasicAuthCredentials AsBasic(this string input) => TryParseBasic(input, out var r) ? r : null!;

        public static bool TryParseBasic(this string input, out BasicAuthCredentials result)
        {
            result = null!;
            if (string.IsNullOrWhiteSpace(input)) return false;
            var value = input.Trim();
            if (value.StartsWith("Basic ", StringComparison.OrdinalIgnoreCase)) value = value.Substring(6).Trim();
            try
            {
                var text = Encoding.UTF8.GetString(Convert.FromBase64String(value));
                var colon = text.IndexOf(':');
                if (colon < 0) return false;
                result = new BasicAuthCredentials(text.Substring(0, colon), text.Substring(colon + 1));
                return true;
            }
            catch (FormatException)
            {
                return false;
            }
        }

        public static Jwt AsJwt(this string input) => Jwt.Parse(input)!;

        public static bool TryParseJwt(this string input, out Jwt result)
        {
            result = Jwt.Parse(input)!;
            return result != null;
        }

        public static byte[] Encrypt(this byte[] input, string alg, byte[] key, byte[] iv)
        {
            using var a = Algorithm(alg);
            return Encrypt(input, a, key, iv);
        }

        public static byte[] Encrypt(this byte[] input, SymmetricAlgorithm alg)
        {
            using var t = alg.CreateEncryptor();
            return t.TransformFinalBlock(input, 0, input.Length);
        }

        public static byte[] Encrypt(this byte[] input, SymmetricAlgorithm alg, byte[] key, byte[] iv)
        {
            using var t = alg.CreateEncryptor(key, iv);
            return t.TransformFinalBlock(input, 0, input.Length);
        }

        public static byte[] Decrypt(this byte[] input, string alg, byte[] key, byte[] iv)
        {
            using var a = Algorithm(alg);
            return Decrypt(input, a, key, iv);
        }

        public static byte[] Decrypt(this byte[] input, SymmetricAlgorithm alg)
        {
            using var t = alg.CreateDecryptor();
            return t.TransformFinalBlock(input, 0, input.Length);
        }

        public static byte[] Decrypt(this byte[] input, SymmetricAlgorithm alg, byte[] key, byte[] iv)
        {
            using var t = alg.CreateDecryptor(key, iv);
            return t.TransformFinalBlock(input, 0, input.Length);
        }

        public static bool VerifyNoRevocation(this X509Certificate2 input)
        {
            using var chain = new X509Chain();
            chain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
            return chain.Build(input);
        }

        public static string ToQueryString(this IDictionary<string, IList<string>> form) =>
            string.Join("&", form.SelectMany(kv => kv.Value.Select(v => WebUtility.UrlEncode(kv.Key) + "=" + WebUtility.UrlEncode(v))));

        public static string ToFormUrlEncodedContent(this IDictionary<string, IList<string>> form) => ToQueryString(form);

        /// <summary>The algorithms the name-taking overloads accept, by the names .NET Framework's Create used.</summary>
        private static SymmetricAlgorithm Algorithm(string name)
        {
            switch ((name ?? "").ToUpperInvariant())
            {
                case "AES":
                case "RIJNDAEL":
                case "SYSTEM.SECURITY.CRYPTOGRAPHY.AES":
                case "SYSTEM.SECURITY.CRYPTOGRAPHY.RIJNDAELMANAGED":
                    return Aes.Create();
                case "TRIPLEDES":
                case "3DES":
                case "SYSTEM.SECURITY.CRYPTOGRAPHY.TRIPLEDES":
                    return TripleDES.Create();
#pragma warning disable SYSLIB0021, CA5351
                case "DES":
                case "SYSTEM.SECURITY.CRYPTOGRAPHY.DES":
                    return DES.Create();
#pragma warning restore SYSLIB0021, CA5351
                default:
                    throw new CryptographicException($"Unknown symmetric algorithm '{name}'.");
            }
        }
    }

    public static class NamedValues
    {
        /// <summary>The run's named values; the runner sets them for each run.</summary>
        internal static readonly AsyncLocal<IReadOnlyDictionary<string, string>?> Current = new AsyncLocal<IReadOnlyDictionary<string, string>?>();

        public static string Get(string name) =>
            Current.Value != null && Current.Value.TryGetValue(name, out var v) ? v : throw new KeyNotFoundException($"Named value '{name}' isn't set in the test.");
    }
}
