import { formatUnits } from "@andronode/protocol/money";
export const usd = (units: bigint) => formatUnits(units);
export const pct = (n: number) => `${Math.round(n * 100)}%`;
export function download(filename: string, text: string, mime = "application/json"): boolean {
  try {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch {
    return false;
  }
}
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
