export type CtxUi = {
  select: (title: string, options: string[]) => Promise<string | undefined>;
  input: (prompt: string, defaultValue?: string) => Promise<string | undefined>;
  confirm: (title: string, message: string) => Promise<boolean>;
  notify: (message: string, level: "info" | "error") => void;
  custom?: <T>(
    factory: (
      tui: unknown,
      theme: unknown,
      keybindings: unknown,
      done: (result: T) => void,
    ) => unknown,
  ) => Promise<T>;
};
