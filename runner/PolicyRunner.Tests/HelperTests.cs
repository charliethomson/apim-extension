using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using Apim.Policies;
using PolicyRunner;
using Xunit;

namespace PolicyRunner.Tests
{
    public class HelperTests
    {
        private static string B64Url(string json) => Convert.ToBase64String(Encoding.UTF8.GetBytes(json)).TrimEnd('=').Replace('+', '-').Replace('/', '_');

        [Fact]
        public void ReadsDictionariesTheWayTheGatewayDoes()
        {
            IReadOnlyDictionary<string, string[]> headers = new Multimap(true, new[] { new KeyValuePair<string, string[]>("Accept", new[] { "a", "b" }) });
            Assert.Equal("a,b", headers.GetValueOrDefault("accept", "x"));
            Assert.Equal("x", headers.GetValueOrDefault("missing", "x"));
            Assert.Null(headers.GetValueOrDefault("missing"));
            IReadOnlyDictionary<string, string> matched = new Dictionary<string, string> { ["id"] = "7" };
            Assert.Equal("7", matched.GetValueOrDefault("id"));
            Assert.Equal("d", matched.GetValueOrDefault("nope", "d"));
            IReadOnlyDictionary<string, object> vars = new Dictionary<string, object> { ["n"] = 3 };
            Assert.Equal(3, vars.GetValueOrDefault<int>("n"));
            Assert.Equal(9, vars.GetValueOrDefault<int>("m", 9));
            Assert.Equal(3, vars.GetValueOrDefault("n"));
            Assert.Throws<InvalidCastException>(() => vars.GetValueOrDefault<string>("n"));
        }

        [Fact]
        public void ParsesJwtsWithoutCheckingTheSignature()
        {
            var token = $"{B64Url("{\"alg\":\"RS256\",\"typ\":\"JWT\"}")}.{B64Url("{\"sub\":\"u1\",\"aud\":[\"a\",\"b\"],\"exp\":1700000000,\"roles\":[\"r\"],\"n\":5}")}.sig";
            var jwt = ("Bearer " + token).AsJwt();
            Assert.Equal("RS256", jwt.Algorithm);
            Assert.Equal("u1", jwt.Subject);
            Assert.Equal(new[] { "a", "b" }, jwt.Audiences);
            Assert.Equal(new DateTime(2023, 11, 14, 22, 13, 20, DateTimeKind.Utc), jwt.ExpirationTime);
            Assert.Equal(new[] { "5" }, jwt.Claims["n"]);
            Assert.Null(jwt.Issuer);
            Assert.False("not.a.jwt!".TryParseJwt(out _));
            Assert.Null("".AsJwt());
        }

        [Fact]
        public void ParsesBasicCredentials()
        {
            var value = "Basic " + Convert.ToBase64String(Encoding.UTF8.GetBytes("me:p:w"));
            Assert.Equal("me", value.AsBasic().UserId);
            Assert.Equal("p:w", value.AsBasic().Password);
            Assert.False("Basic !!!".TryParseBasic(out _));
            Assert.Null(Convert.ToBase64String(Encoding.UTF8.GetBytes("nocolon")).AsBasic());
        }

        [Fact]
        public void EncryptsAndDecryptsRoundTrip()
        {
            var key = new byte[32];
            var iv = new byte[16];
            var data = Encoding.UTF8.GetBytes("secret");
            Assert.Equal(data, data.Encrypt("Aes", key, iv).Decrypt("Aes", key, iv));
            using var aes = Aes.Create();
            Assert.Equal(data, data.Encrypt(aes).Decrypt(aes));
            Assert.Throws<CryptographicException>(() => data.Encrypt("Nope", key, iv));
        }

        [Fact]
        public void FormatsForms()
        {
            var form = new MessageBody("a=1&b=x%20y&a=2").AsFormUrlEncodedContent();
            Assert.Equal(new[] { "1", "2" }, form["a"]);
            Assert.Equal("a=1&a=2&b=x+y", form.ToQueryString());
        }

        [Fact]
        public void ReadsBodiesAsTheTypesTheGatewayAllows()
        {
            Assert.Equal("v", (string?)new MessageBody("{\"k\":\"v\"}").As<Newtonsoft.Json.Linq.JObject>(true)["k"]);
            Assert.Equal("a", new MessageBody("<a/>").As<System.Xml.Linq.XElement>().Name.LocalName);
            Assert.Null(new MessageBody(null).As<Newtonsoft.Json.Linq.JObject>());
            Assert.Throws<InvalidOperationException>(() => new MessageBody("x").As<int>());
            var body = new MessageBody("once");
            Assert.Equal("once", body.As<string>());
            Assert.Equal("", body.As<string>());
        }

        [Fact]
        public void KnowsReasonPhrases()
        {
            Assert.Equal("Not Found", Response.ReasonFor(404));
            Assert.Equal("", Response.ReasonFor(599));
            Assert.Equal("https://h.example:8443/a%20b?x=1&y=", new Url("https://h.example:8443/a%20b?x=1&y").ToString());
            Assert.Equal("", new Url("https://h.example/").QueryString);
        }
    }
}
