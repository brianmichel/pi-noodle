# Memory System Evaluation Plan

## Goal

Evaluate whether the memory system makes the agent feel meaningfully more helpful without becoming noisy, stale, invasive, or wrong.

The system should be judged on user-visible outcomes:

- It remembers durable facts and preferences.
- It ignores temporary or sensitive details.
- It retrieves the right memories at the right time.
- It avoids injecting irrelevant memories.
- It respects explicit forget/update requests.

## 1. Define Eval Case Types

### Capture evals

Test whether the system saves the right things.

Examples:

- Explicit preference: “Remember that I prefer concise TypeScript examples.”
- Identity: “My name is Brian.”
- Project decision: “For pi-noodle, we’re using Turso for vector search.”
- Temporary instruction: “For this task, be extra verbose.”
- Sensitive content: “My API key is sk-...”
- Repeated implicit preference: “I usually prefer Go for small daemons.”

### Retrieval evals

Test whether the system returns the right memories later.

Examples:

- Query about implementation style should retrieve coding preferences.
- Query about the repo should retrieve project-specific decisions.
- Generic unrelated prompt should not retrieve project memories.
- Temporary memories should not appear later.

### Update/forget evals

Test user control.

Examples:

- “Forget that I prefer Go.”
- “Actually, use Rust for this daemon.”
- “What do you remember about this project?”

### End-to-end evals

Test whether final answers improve.

Example:

1. User previously says: “For pi-noodle, we use Turso and TypeScript.”
2. Later asks: “How should I implement memory search?”
3. Good answer mentions Turso, TypeScript, and the existing memory interface.

## 2. Eval Case Shape

```ts
type MemoryEvalCase = {
  name: string;
  messages: string[];

  expectedSaved?: string[];
  expectedNotSaved?: string[];

  queries?: Array<{
    query: string;
    shouldRetrieve: string[];
    shouldNotRetrieve?: string[];
  }>;

  forget?: Array<{
    command: string;
    laterQuery: string;
    shouldNotRetrieve: string[];
  }>;
};
```
