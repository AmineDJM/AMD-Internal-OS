import { prismaBrut } from "@/lib/prisma";
import { extensionCapture } from "./capture";

/**
 * LE CLIENT QUI CAPTURE (J7, décision 0029) — le client de base, avec l'extension de capture. Construit une fois.
 * La simulation ouvre sa transaction annulée sur lui ; un geste réel journalisé y fait passer ses requêtes.
 */
const g = globalThis as { __amdClientCapturant?: unknown };

export function clientCapturant() {
  type Capturant = ReturnType<typeof construire>;
  return (g.__amdClientCapturant ??= construire()) as Capturant;
}

function construire() {
  return prismaBrut.$extends(extensionCapture(prismaBrut as unknown as Record<string, unknown>));
}
