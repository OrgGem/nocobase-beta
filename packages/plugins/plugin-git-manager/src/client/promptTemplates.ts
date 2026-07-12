export interface ReviewPromptTemplate {
  key: 'application' | 'workflow-config';
  label: string;
  text: string;
}

export const REVIEW_PROMPT_TEMPLATES: ReviewPromptTemplate[] = [
  {
    key: 'application',
    label: 'Application code (C#, .NET, Java, JS/TS…)',
    text: `Please review the code changes with a focus on:
1. Best Practices & Style:
   - C#/VB.NET: Follow standard naming conventions (PascalCase for methods/properties, camelCase for fields). Ensure proper use of async/await (avoid .Result/.Wait()). Use LINQ efficiently.
   - Java: Follow standard naming conventions. Check null-safety (Optional, null checks). Prefer try-with-resources for closeable resources and use streams/collections idiomatically.
   - JS/TS: Use strict equality (===), prefer const/let. Ensure TypeScript types are explicit and avoid 'any'.
2. Performance: Watch out for N+1 queries, unnecessary loops, and memory leaks.
3. Security: Identify potential SQL injections, XSS vulnerabilities, and improper data validation.
4. Maintainability: Check for readability, SOLID principles, and DRY. Ensure meaningful naming.
5. Error Handling: Verify that exceptions are properly caught, handled, and logged.`,
  },
  {
    key: 'workflow-config',
    label: 'Workflow / Config (XML, XAML, YAML, JSON…)',
    text: `Please review the workflow/configuration files (XML, XAML, YAML, JSON, ...) with a focus on:
1. Structure & Validity: Well-formed syntax, correct schema/namespace usage, no duplicate or conflicting keys, consistent indentation and encoding.
2. Workflow Logic: Unreachable or dead steps, missing error handling / retry / timeout settings, incorrect transitions or dependencies between steps, infinite loops.
3. Security: Hardcoded credentials, secrets, tokens or connection strings; insecure endpoints (http instead of https); overly broad permissions.
4. Environment & Portability: Hardcoded environment-specific values (paths, hosts, ports) that should be parameterized; missing default values.
5. Maintainability: Meaningful naming for steps/variables, duplicated blocks that should be shared, obsolete or unused entries.`,
  },
];
