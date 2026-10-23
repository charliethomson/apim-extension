#!/usr/bin/env dotnet
// Generates data/csharp-model.json: the public surface of every type on the APIM allowlist, the
// types they derive from, and the types their members mention, with doc summaries. The built-in
// C# engine (src/csharp/lang/) reads it for completion, hover, signature help and type checking.
//
// Type references are written as the type's metadata name (`System.Collections.Generic.List`1`,
// nested types with `+`), then `<args>` for generics and `[]` for arrays. Generic parameters are
// bare names (`T`, `TSource`).
//
// The surface comes from the newest .NET, which has the best doc files, but APIM's expression
// types are .NET Framework's. Types and members (down to single overloads) that .NET Framework 4.8
// lacks are marked `nf`, from Microsoft's net48 reference assemblies.
//
// Run from the repo root: dotnet run tools/gen-csharp-model.cs
#:package System.Reflection.MetadataLoadContext@10.0.0
#:package Newtonsoft.Json@13.0.3
#:package Microsoft.NETFramework.ReferenceAssemblies.net48@1.0.3
#:property PublishAot=false

using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Xml.Linq;

var refDir = FindRefPack();
var newtonsoft = typeof(Newtonsoft.Json.JsonConvert).Assembly.Location;
var paths = Directory.GetFiles(refDir, "*.dll").Append(newtonsoft).ToList();
using var mlc = new MetadataLoadContext(new PathAssemblyResolver(paths));

// .NET Framework 4.8's public surface, as member signatures by type name.
var netfxDir = FindNetFxPack();
var netfxPaths = Directory.GetFiles(netfxDir, "*.dll").Concat(Directory.GetFiles(Path.Combine(netfxDir, "Facades"), "*.dll")).ToList();
using var netfxMlc = new MetadataLoadContext(new PathAssemblyResolver(netfxPaths), "mscorlib");
var netfx = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);
foreach (var path in Directory.GetFiles(netfxDir, "*.dll"))
{
    Assembly asm;
    try { asm = netfxMlc.LoadFromAssemblyPath(path); } catch { continue; }
    Type[] exported;
    try { exported = asm.GetExportedTypes(); } catch { continue; }
    foreach (var t in exported)
    {
        if (t.FullName is not { } fn || netfx.ContainsKey(fn)) continue;
        const BindingFlags everything = BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static | BindingFlags.FlattenHierarchy;
        var sigs = new HashSet<string>(StringComparer.Ordinal);
        try { foreach (var m in t.GetMembers(everything)) sigs.Add(Sig(m)); } catch { }
        // Interfaces' members are reachable through the interface, not FlattenHierarchy.
        if (t.IsInterface) foreach (var i in SafeInterfaces(t)) try { foreach (var m in i.GetMembers(everything)) sigs.Add(Sig(m)); } catch { }
        netfx[fn] = sigs;
    }
}

// Doc summaries, by doc comment id.
var docs = new Dictionary<string, string>(StringComparer.Ordinal);
foreach (var xml in Directory.GetFiles(refDir, "*.xml").Append(Path.ChangeExtension(newtonsoft, ".xml")))
{
    if (!File.Exists(xml)) continue;
    try
    {
        foreach (var m in XDocument.Load(xml).Descendants("member"))
        {
            var id = (string?)m.Attribute("name");
            var summary = m.Element("summary");
            if (id is null || summary is null) continue;
            docs.TryAdd(id, Summarize(summary));
        }
    }
    catch { }
}

// Every exported type by metadata name.
var all = new Dictionary<string, Type>(StringComparer.Ordinal);
foreach (var path in paths)
{
    Assembly asm;
    try { asm = mlc.LoadFromAssemblyPath(path); } catch { continue; }
    Type[] exported;
    try { exported = asm.GetExportedTypes(); } catch { continue; }
    foreach (var t in exported) if (t.FullName is { } fn) all.TryAdd(fn, t);
}

var allowlist = JsonDocument.Parse(File.ReadAllText("data/allowed-types.json")).RootElement;
var roots = allowlist.GetProperty("types").EnumerateObject().Select(p => p.Name)
    .Concat(allowlist.GetProperty("implicit").GetProperty("types").EnumerateArray().Select(e => e.GetString()!))
    .Concat(Extra)
    .ToList();

// Roots get their full surface. Types their signatures mention get one hop: included, but the
// types *they* mention aren't followed, so the closure stays small.
var included = new SortedDictionary<string, Type>(StringComparer.Ordinal);
var queue = new Queue<(Type, int)>();
void Include(Type t, int depth)
{
    t = Definition(t);
    if (t.FullName is null || t.IsGenericParameter || t.IsPointer || t.IsByRef) return;
    if (!IsInteresting(t)) return;
    if (included.ContainsKey(t.FullName)) return;
    included[t.FullName] = t;
    queue.Enqueue((t, depth));
}
foreach (var r in roots)
{
    if (all.TryGetValue(r, out var t)) Include(t, 0);
    else Console.Error.WriteLine($"not found: {r}");
}

var output = new SortedDictionary<string, object>(StringComparer.Ordinal);
while (queue.Count > 0)
{
    var (t, depth) = queue.Dequeue();
    // Bases and interfaces are always followed: member lookup walks them.
    for (var b = t.BaseType; b is not null; b = b.BaseType) Include(b, depth);
    foreach (var i in SafeInterfaces(t)) Include(i, depth);
    var members = Members(t).ToList();
    if (depth == 0)
    {
        foreach (var m in members)
            foreach (var r in Mentions(m))
                Include(r, 1);
    }
}

foreach (var (name, t) in included) output[name] = DescribeType(t);

var json = JsonSerializer.Serialize(new
{
    comment = $"Generated by tools/gen-csharp-model.cs from {Path.GetFileName(Path.GetDirectoryName(refDir))} reference assemblies and Newtonsoft.Json, with nf marking what .NET Framework 4.8 lacks. Do not edit.",
    types = output,
}, new JsonSerializerOptions { WriteIndented = false, DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull });
File.WriteAllText("data/csharp-model.json", json + "\n");
Console.WriteLine($"{output.Count} types, {json.Length / 1024} KB");

// ---- description ------------------------------------------------------------------------------

object DescribeType(Type t)
{
    string kind = t.IsEnum ? "enum" : t.IsInterface ? "interface" : t.IsValueType ? "struct" : IsDelegate(t) ? "delegate" : "class";
    var typeParams = t.IsGenericTypeDefinition ? t.GetGenericArguments().Select(a => a.Name).ToArray() : null;
    string? baseType = t.BaseType is { } b && !t.IsInterface && !t.IsEnum && !t.IsValueType && kind != "delegate" ? Ref(b) : null;
    var ifaces = SafeInterfaces(t).Where(i => IsInteresting(Definition(i))).Select(Ref).ToArray();
    var flags = new List<string>();
    if (t.IsAbstract && t.IsSealed) flags.Add("static");
    else if (t.IsAbstract && !t.IsInterface) flags.Add("abstract");
    // Variance on interface and delegate type parameters (IEnumerable<out T>).
    string[]? variance = null;
    if (t.IsGenericTypeDefinition && (t.IsInterface || kind == "delegate"))
    {
        variance = t.GetGenericArguments().Select(a =>
            (a.GenericParameterAttributes & GenericParameterAttributes.Covariant) != 0 ? "out" :
            (a.GenericParameterAttributes & GenericParameterAttributes.Contravariant) != 0 ? "in" : "").ToArray();
        if (variance.All(v => v == "")) variance = null;
    }
    return new
    {
        k = kind,
        g = typeParams,
        v = variance,
        f = flags.Count > 0 ? flags.ToArray() : null,
        b = baseType,
        i = ifaces.Length > 0 ? ifaces : null,
        nf = TypeNotInFramework(t) ? 1 : (int?)null,
        d = Doc("T:" + DocName(t)),
        m = Members(t).Select(m => WithFramework(m, DescribeMember(m))).Where(m => m is not null).ToArray(),
    };
}

object? DescribeMember(MemberInfo m)
{
    switch (m)
    {
        case FieldInfo f:
            if (f.IsSpecialName) return null; // enum value__
            return new
            {
                n = f.Name,
                k = f.DeclaringType!.IsEnum ? "e" : f.IsLiteral ? "c" : "f",
                s = f.IsStatic && !f.DeclaringType.IsEnum ? 1 : (int?)null,
                t = Ref(f.FieldType),
                val = f.IsLiteral && f.DeclaringType.IsEnum ? Convert.ToInt64(f.GetRawConstantValue()) : (long?)null,
                d = Doc($"F:{DocName(f.DeclaringType)}.{f.Name}"),
            };
        case PropertyInfo p:
        {
            var acc = p.GetMethod ?? p.SetMethod!;
            var idx = p.GetIndexParameters();
            return new
            {
                n = idx.Length > 0 ? "this[]" : p.Name,
                k = idx.Length > 0 ? "i" : "p",
                s = acc.IsStatic ? 1 : (int?)null,
                t = Ref(p.PropertyType),
                p = idx.Length > 0 ? idx.Select(Param).ToArray() : null,
                w = p.SetMethod is { IsPublic: true } ? 1 : (int?)null,
                d = Doc($"P:{DocName(p.DeclaringType!)}.{p.Name}{DocParams(idx, Array.Empty<Type>(), p.DeclaringType!)}"),
            };
        }
        case ConstructorInfo c:
            return new
            {
                n = ".ctor",
                k = "ctor",
                p = c.GetParameters().Select(Param).ToArray(),
                d = Doc($"M:{DocName(c.DeclaringType!)}.#ctor{DocParams(c.GetParameters(), Array.Empty<Type>(), c.DeclaringType!)}"),
            };
        case MethodInfo mi:
        {
            var gargs = mi.IsGenericMethodDefinition ? mi.GetGenericArguments() : Array.Empty<Type>();
            var isOp = mi.IsSpecialName && mi.Name.StartsWith("op_");
            var ext = mi.IsStatic && HasAttribute(mi, "System.Runtime.CompilerServices.ExtensionAttribute");
            var dn = $"M:{DocName(mi.DeclaringType!)}.{mi.Name}{(gargs.Length > 0 ? "``" + gargs.Length : "")}{DocParams(mi.GetParameters(), gargs, mi.DeclaringType!)}";
            if (isOp && (mi.Name == "op_Implicit" || mi.Name == "op_Explicit")) dn += "~" + DocType(mi.ReturnType, gargs, mi.DeclaringType!);
            return new
            {
                n = mi.Name,
                k = isOp ? "op" : "m",
                s = mi.IsStatic ? 1 : (int?)null,
                x = ext ? 1 : (int?)null,
                g = gargs.Length > 0 ? gargs.Select(a => a.Name).ToArray() : null,
                gc = gargs.Any(a => Constraints(a).Length > 0) ? gargs.Select(Constraints).ToArray() : null,
                t = Ref(mi.ReturnType),
                p = mi.GetParameters().Select(Param).ToArray(),
                d = isOp ? null : Doc(dn),
            };
        }
    }
    return null;
}

// ---- .NET Framework 4.8 --------------------------------------------------------------------------

bool TypeNotInFramework(Type t) => !t.FullName!.StartsWith("Newtonsoft.") && !netfx.ContainsKey(t.FullName!);

/** Adds `nf = 1` to a described member that .NET Framework 4.8 doesn't have on the type or its bases. */
object? WithFramework(MemberInfo m, object? described)
{
    if (described is null) return null;
    var t = m.DeclaringType!;
    if (t.FullName!.StartsWith("Newtonsoft.") || TypeNotInFramework(t)) return described;
    if (netfx[t.FullName!].Contains(Sig(m))) return described;
    var dict = JsonSerializer.SerializeToElement(described).EnumerateObject().ToDictionary(p => p.Name, p => (object?)p.Value);
    dict["nf"] = 1;
    return dict;
}

/** A member's signature, comparable across the two load contexts: kind, name, arity and parameter types. */
static string Sig(MemberInfo m) => m switch
{
    FieldInfo f => "F:" + f.Name,
    PropertyInfo p => "P:" + p.Name + SigParams(p.GetIndexParameters()),
    ConstructorInfo c => "C:" + SigParams(c.GetParameters()),
    MethodInfo mi => "M:" + mi.Name + "`" + (mi.IsGenericMethodDefinition ? mi.GetGenericArguments().Length : 0) + SigParams(mi.GetParameters())
        + (mi.Name is "op_Implicit" or "op_Explicit" ? "~" + SigType(mi.ReturnType) : ""),
    _ => "?:" + m.Name,
};

static string SigParams(ParameterInfo[] ps) => "(" + string.Join(",", ps.Select(p => SigType(p.ParameterType))) + ")";

static string SigType(Type t)
{
    if (t.IsByRef) return SigType(t.GetElementType()!) + "&";
    if (t.IsArray) return SigType(t.GetElementType()!) + "[" + new string(',', t.GetArrayRank() - 1) + "]";
    if (t.IsPointer) return SigType(t.GetElementType()!) + "*";
    if (t.IsGenericParameter) return (t.DeclaringMethod is not null ? "!!" : "!") + t.GenericParameterPosition;
    if (t.IsGenericType && !t.IsGenericTypeDefinition)
        return t.GetGenericTypeDefinition().FullName + "<" + string.Join(",", t.GetGenericArguments().Select(SigType)) + ">";
    return t.FullName ?? t.Name;
}

static string FindNetFxPack()
{
    var root = Environment.GetEnvironmentVariable("NUGET_PACKAGES") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".nuget", "packages");
    var pkg = Path.Combine(root, "microsoft.netframework.referenceassemblies.net48");
    var version = Directory.GetDirectories(pkg).OrderByDescending(d => d).First();
    return Path.Combine(version, "build", ".NETFramework", "v4.8");
}

/** Base type and interface constraints on a generic parameter, plus "class" or "struct". */
string[] Constraints(Type arg)
{
    var list = new List<string>();
    var attrs = arg.GenericParameterAttributes;
    if ((attrs & GenericParameterAttributes.NotNullableValueTypeConstraint) != 0) list.Add("struct");
    else if ((attrs & GenericParameterAttributes.ReferenceTypeConstraint) != 0) list.Add("class");
    foreach (var c in arg.GetGenericParameterConstraints())
    {
        if (c.FullName == "System.ValueType") continue;
        list.Add(Ref(c));
    }
    return list.ToArray();
}

object Param(ParameterInfo p)
{
    string? mod = null;
    var type = p.ParameterType;
    if (type.IsByRef)
    {
        type = type.GetElementType()!;
        mod = p.IsOut ? "out" : p.IsIn ? "in" : "ref";
    }
    else if (HasAttribute(p, "System.ParamArrayAttribute")) mod = "params";
    if (p.Position == 0 && p.Member is MethodInfo mi && mi.IsStatic && HasAttribute(mi, "System.Runtime.CompilerServices.ExtensionAttribute")) mod = "this";
    return new
    {
        n = p.Name,
        t = Ref(type),
        m = mod,
        o = p.IsOptional || p.HasDefaultValue ? DefaultText(p) : null,
    };
}

string DefaultText(ParameterInfo p)
{
    object? v;
    try { v = p.RawDefaultValue; } catch { return "default"; }
    return v switch
    {
        null => "null",
        DBNull or Missing => "default",
        string s => "\"" + s + "\"",
        bool b => b ? "true" : "false",
        char c => $"'{c}'",
        _ => p.ParameterType.IsEnum ? $"({p.ParameterType.Name}){v}" : Convert.ToString(v, System.Globalization.CultureInfo.InvariantCulture) ?? "default",
    };
}

IEnumerable<MemberInfo> Members(Type t)
{
    const BindingFlags flags = BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly;
    MemberInfo[] members;
    try { members = t.GetMembers(flags); } catch { yield break; }
    foreach (var m in members)
    {
        if (m is Type || m is EventInfo) continue;
        if (Hidden(m)) continue;
        if (m is MethodInfo mi && mi.IsSpecialName && !mi.Name.StartsWith("op_")) continue; // accessors
        if (m is MethodInfo { IsGenericMethodDefinition: false } && m.Name.Contains('.')) continue; // explicit impls
        if (!Supported(m)) continue;
        yield return m;
    }
}

/** Members whose signatures need C# features policy expressions don't have. */
bool Supported(MemberInfo m)
{
    IEnumerable<Type> types = m switch
    {
        FieldInfo f => [f.FieldType],
        PropertyInfo p => p.GetIndexParameters().Select(x => x.ParameterType).Append(p.PropertyType),
        MethodBase mb => mb.GetParameters().Select(x => x.ParameterType).Concat(mb is MethodInfo mi ? [mi.ReturnType] : []),
        _ => [],
    };
    try
    {
        return types.All(SupportedType);
    }
    catch { return false; }
}

bool SupportedType(Type t)
{
    if (t.IsByRef) t = t.GetElementType()!;
    if (t.IsPointer || t.IsFunctionPointer) return false;
    if (t.IsArray) return SupportedType(t.GetElementType()!);
    if (t.IsGenericParameter) return true;
    var def = Definition(t);
    if (def.FullName is "System.Span`1" or "System.ReadOnlySpan`1" or "System.Memory`1" or "System.ReadOnlyMemory`1" or "System.TypedReference" or "System.ArgIterator" or "System.RuntimeArgumentHandle") return false;
    if (HasAttribute(def, "System.Runtime.CompilerServices.IsByRefLikeAttribute")) return false;
    if (Excluded(def)) return false;
    if (def.Namespace is { } ns && (ns.StartsWith("System.Threading.Tasks") || ns.StartsWith("System.Buffers") || ns == "System.Text.Unicode")) return false;
    if (t.IsGenericType && !t.IsGenericTypeDefinition) return t.GetGenericArguments().All(SupportedType);
    return true;
}

bool Hidden(MemberInfo m)
{
    foreach (var a in SafeAttributes(m))
    {
        var n = a.AttributeType.FullName;
        if (n == "System.ComponentModel.EditorBrowsableAttribute" && a.ConstructorArguments.Count == 1 && Convert.ToInt32(a.ConstructorArguments[0].Value) == 1) return true;
        if (n == "System.ObsoleteAttribute" && a.ConstructorArguments.Count >= 2 && a.ConstructorArguments[1].Value is true) return true;
    }
    return false;
}

IEnumerable<Type> Mentions(MemberInfo m)
{
    IEnumerable<Type> types = m switch
    {
        FieldInfo f => [f.FieldType],
        PropertyInfo p => p.GetIndexParameters().Select(x => x.ParameterType).Append(p.PropertyType),
        MethodBase mb => mb.GetParameters().Select(x => x.ParameterType).Concat(mb is MethodInfo mi ? [mi.ReturnType] : []),
        _ => [],
    };
    foreach (var t in types)
        foreach (var x in Flatten(t))
            yield return x;
}

IEnumerable<Type> Flatten(Type t)
{
    if (t.IsByRef || t.IsArray || t.IsPointer) { foreach (var x in Flatten(t.GetElementType()!)) yield return x; yield break; }
    if (t.IsGenericParameter) yield break;
    yield return t;
    if (t.IsGenericType && !t.IsGenericTypeDefinition)
        foreach (var a in t.GetGenericArguments())
            foreach (var x in Flatten(a))
                yield return x;
}

bool IsInteresting(Type t) =>
    (t.IsPublic || t.IsNestedPublic) && !Excluded(t)
        ? t.Namespace is { } ns && (ns == "System" || ns.StartsWith("System.") || ns.StartsWith("Newtonsoft.Json")) && !ns.StartsWith("System.Runtime") && (!ns.StartsWith("System.Reflection") || t.FullName == "System.Reflection.MemberInfo") && !ns.StartsWith("System.Threading") && !ns.StartsWith("System.Diagnostics") && !ns.StartsWith("System.ComponentModel") && !ns.StartsWith("System.Buffers")
        : false;

/** Types policy expressions can't meaningfully use: generic math, spans' friends, and the types .NET Framework never had. */
static bool Excluded(Type t)
{
    var fn = t.FullName ?? "";
    var ns = t.Namespace ?? "";
    if (ns is "System.Numerics" or "System.Linq.Expressions" or "System.Dynamic" or "System.Collections.Specialized" or "System.Xml.Serialization" or "System.Xml.XPath") return true;
    if (fn.Contains("+AlternateLookup") || fn.Contains("InterpolatedStringHandler") || fn.Contains("InvocationListEnumerator")) return true;
    return fn is "System.Half" or "System.Int128" or "System.UInt128" or "System.DateOnly" or "System.TimeOnly" or "System.Index" or "System.Range"
        or "System.IntPtr" or "System.UIntPtr" or "System.IParsable`1" or "System.ISpanParsable`1" or "System.ISpanFormattable" or "System.IUtf8SpanFormattable" or "System.IUtf8SpanParsable`1"
        or "System.Text.CompositeFormat" or "System.Text.StringRuneEnumerator" or "System.Text.StringBuilder+ChunkEnumerator" or "System.IAsyncDisposable"
        or "System.Security.Cryptography.MLDsa" or "System.Security.Cryptography.MLKem" or "System.Security.Cryptography.SlhDsa" or "System.Security.Cryptography.CompositeMLDsa"
        or "System.Security.Cryptography.X509Certificates.Pkcs12ExportPbeParameters" or "System.Security.Cryptography.PbeParameters";
}

// ---- type references --------------------------------------------------------------------------

string Ref(Type t)
{
    if (t.IsByRef) return Ref(t.GetElementType()!);
    if (t.IsArray) return Ref(t.GetElementType()!) + "[" + new string(',', t.GetArrayRank() - 1) + "]";
    if (t.IsGenericParameter) return t.Name;
    if (t.IsGenericType)
    {
        var def = t.GetGenericTypeDefinition();
        return def.FullName + "<" + string.Join(",", t.GetGenericArguments().Select(Ref)) + ">";
    }
    if (t.ContainsGenericParameters && t.IsNested) // nested type of a generic, e.g. List`1+Enumerator
        return t.FullName ?? t.Name;
    return t.FullName ?? t.Name;
}

static Type Definition(Type t)
{
    while (t.IsByRef || t.IsArray || t.IsPointer) t = t.GetElementType()!;
    return t.IsGenericType && !t.IsGenericTypeDefinition ? t.GetGenericTypeDefinition() : t;
}

static Type[] SafeInterfaces(Type t)
{
    try { return t.GetInterfaces().Where(i => i.IsPublic || i.IsNestedPublic).ToArray(); } catch { return []; }
}

static IList<CustomAttributeData> SafeAttributes(MemberInfo m)
{
    try { return m.GetCustomAttributesData(); } catch { return []; }
}

static bool HasAttribute(object target, string name) =>
    (target switch
    {
        MemberInfo m => SafeAttributes(m),
        ParameterInfo p => SafeParamAttributes(p),
        _ => [],
    }).Any(a => a.AttributeType.FullName == name);

static IList<CustomAttributeData> SafeParamAttributes(ParameterInfo p)
{
    try { return p.GetCustomAttributesData(); } catch { return []; }
}

static bool IsDelegate(Type t)
{
    try { return t.BaseType?.FullName == "System.MulticastDelegate"; } catch { return false; }
}

// ---- doc ids ----------------------------------------------------------------------------------

string? Doc(string id) => docs.TryGetValue(id, out var d) && d.Length > 0 ? d : null;

static string DocName(Type t) => (t.FullName ?? t.Name).Replace('+', '.');

static string DocParams(ParameterInfo[] ps, Type[] methodArgs, Type declaring) =>
    ps.Length == 0 ? "" : "(" + string.Join(",", ps.Select(p => DocType(p.ParameterType, methodArgs, declaring))) + ")";

static string DocType(Type t, Type[] methodArgs, Type declaring)
{
    if (t.IsByRef) return DocType(t.GetElementType()!, methodArgs, declaring) + "@";
    if (t.IsArray) return DocType(t.GetElementType()!, methodArgs, declaring) + (t.GetArrayRank() == 1 ? "[]" : "[" + string.Join(",", Enumerable.Repeat("0:", t.GetArrayRank())) + "]");
    if (t.IsGenericParameter) return t.DeclaringMethod is not null ? "``" + t.GenericParameterPosition : "`" + t.GenericParameterPosition;
    if (t.IsGenericType)
    {
        var def = t.GetGenericTypeDefinition();
        var name = (def.FullName ?? def.Name).Replace('+', '.');
        name = Regex.Replace(name, "`\\d+", "");
        return name + "{" + string.Join(",", t.GetGenericArguments().Select(a => DocType(a, methodArgs, declaring))) + "}";
    }
    return (t.FullName ?? t.Name).Replace('+', '.');
}

static string Summarize(XElement summary)
{
    var sb = new StringBuilder();
    foreach (var node in summary.Nodes())
    {
        switch (node)
        {
            case XText text: sb.Append(text.Value); break;
            case XElement e when e.Name == "see" || e.Name == "seealso":
                var cref = (string?)e.Attribute("cref") ?? (string?)e.Attribute("langword") ?? (string?)e.Attribute("href") ?? "";
                var label = e.Value.Length > 0 ? e.Value : Regex.Replace(cref, "^[A-Z]:", "");
                label = Regex.Replace(label, "`+\\d+", "");
                label = Regex.Replace(label, "\\(.*\\)$", "");
                var dot = label.LastIndexOf('.');
                if (cref.StartsWith("T:") && dot >= 0) label = label[(dot + 1)..];
                else if (dot >= 0 && cref.Length > 2 && cref[1] == ':') label = label[(label.LastIndexOf('.', dot - 1) + 1)..];
                sb.Append('`').Append(label).Append('`');
                break;
            case XElement e when e.Name == "paramref" || e.Name == "typeparamref":
                sb.Append('`').Append((string?)e.Attribute("name")).Append('`'); break;
            case XElement e when e.Name == "c" || e.Name == "code":
                sb.Append('`').Append(e.Value).Append('`'); break;
            case XElement e: sb.Append(e.Value); break;
        }
    }
    var text2 = Regex.Replace(sb.ToString(), "\\s+", " ").Trim();
    return text2;
}

static string FindRefPack()
{
    var dotnetRoot = Path.GetDirectoryName(Path.GetDirectoryName(RuntimeEnvironment.GetRuntimeDirectory().TrimEnd('/', '\\')))!;
    dotnetRoot = Path.GetDirectoryName(dotnetRoot)!;
    var packs = Path.Combine(dotnetRoot, "packs", "Microsoft.NETCore.App.Ref");
    var version = Directory.GetDirectories(packs).OrderByDescending(d => Version.TryParse(Path.GetFileName(d).Split('-')[0], out var v) ? v : new Version()).First();
    return Directory.GetDirectories(Path.Combine(version, "ref")).OrderByDescending(d => d).First();
}

partial class Program
{
    /** Types the engine needs that the allowlist doesn't name: delegates for lambdas, LINQ's return types, interfaces arrays and strings implement. */
    static readonly string[] Extra =
    [
        "System.Object", "System.ValueType", "System.Enum", "System.Delegate", "System.MulticastDelegate",
        "System.Func`1", "System.Func`2", "System.Func`3", "System.Func`4", "System.Func`5",
        "System.Action", "System.Action`1", "System.Action`2", "System.Action`3",
        "System.Predicate`1", "System.Comparison`1", "System.Converter`2",
        "System.IComparable", "System.IComparable`1", "System.IEquatable`1", "System.IFormattable", "System.IFormatProvider", "System.IDisposable", "System.ICloneable",
        "System.Collections.IEnumerable", "System.Collections.IEnumerator", "System.Collections.ICollection", "System.Collections.IList",
        "System.Collections.Generic.IComparer`1", "System.Collections.Generic.IEqualityComparer`1",
        "System.Collections.Generic.IReadOnlyList`1", "System.Collections.Generic.SortedDictionary`2", "System.Collections.Generic.LinkedList`1",
        "System.Linq.IGrouping`2", "System.Linq.ILookup`2", "System.Linq.IOrderedEnumerable`1", "System.Linq.Lookup`2",
        "System.Text.RegularExpressions.MatchCollection",
        "System.Globalization.CultureInfo", "System.Globalization.NumberStyles", "System.Globalization.DateTimeStyles",
        "System.Tuple`1", "System.Tuple`2", "System.Tuple`3", "System.Tuple`4",
        "System.ValueTuple`2", "System.ValueTuple`3",
        "System.Xml.Linq.LoadOptions", "System.Xml.Linq.SaveOptions",
    ];
}
