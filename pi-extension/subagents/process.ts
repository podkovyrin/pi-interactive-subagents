import { execFileSync } from "node:child_process";

const commandAvailability = new Map<string, boolean>();

export function hasCommand(command: string): boolean {
  const key = `${process.env.PATH}\0${command}`;
  if (commandAvailability.has(key)) return commandAvailability.get(key)!;

  let available = false;
  try {
    execFileSync("/bin/sh", ["-c", 'command -v "$1"', "sh", command], {
      stdio: "ignore",
      timeout: 5000,
    });
    available = true;
  } catch {}
  commandAvailability.set(key, available);
  return available;
}
