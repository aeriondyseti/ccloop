export const isENOENT = (err: unknown): boolean =>
  (err as NodeJS.ErrnoException)?.code === "ENOENT";
