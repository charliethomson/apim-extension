# test/stubs

Compiles [`stubs/ApimContext.cs`](../../stubs/ApimContext.cs) and a few sample expressions
([`Samples.cs`](Samples.cs)) at C# 7.3, the language APIM compiles policy expressions as, so a
stub that doesn't compile fails CI instead of confusing the engine. Nothing here ships.

```bash
dotnet build test/stubs
```
