// Expressions from the docs and fixtures, written the way the shadow generator emits them.
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using Newtonsoft.Json.Linq;
using Apim.Policies;

static class Samples
{
    static object E0(IProxyRequestContext context) => context.Request.Headers.GetValueOrDefault("X-Mode", "") == "debug" && context.Variables.GetValueOrDefault<bool>("isPost");
    static object E1(IProxyRequestContext context) => context.Request.Headers.GetValueOrDefault("Authorization", "").AsJwt()?.Claims.GetValueOrDefault("sub", "anon");
    static object E2(IProxyRequestContext context) => context.Variables.GetValueOrDefault("count", 0) + 1;
    static string E3(IProxyRequestContext context) => context.User?.Email ?? "anonymous";
    static object E4(IProxyRequestContext context)
    {
        var body = context.Request.Body.As<JObject>(preserveContent: true);
        var ids = body["items"].Select(i => (string)i["id"]).Where(id => id.Length < 10).ToList();
        if (ids.Count > 0) { body["first"] = ids[0]; }
        return body.ToString();
    }
    static object E5(IProxyRequestContext context) => Regex.Match(context.Request.Url.Path, "/(?<id>\\d+)").Groups["id"]?.Value;
    static object E6(IProxyRequestContext context) => Convert.ToBase64String(Encoding.UTF8.GetBytes(context.Request.IpAddress));
    static object E7(IProxyRequestContext context) => context.Request.Body.AsFormUrlEncodedContent(true).ToQueryString();
    static object E8(IProxyRequestContext context) => context.Deployment.Gateway.IsManaged ? context.Deployment.Region : context.Deployment.GatewayId;
    static object E9(IProxyRequestContext context) { BasicAuthCredentials c; return context.Request.Headers.GetValueOrDefault("Authorization").TryParseBasic(out c) ? c.UserId : null; }
}
