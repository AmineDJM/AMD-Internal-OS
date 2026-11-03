import { describe, expect, it } from "vitest";
import AncienneAdresseChiefOfStaff from "../chief-of-staff/page";
import AncienneAdresseBoiteAdam from "../chief-of-staff/inbox/page";
import AncienneAdresseReglagesAdam from "../chief-of-staff/reglages/page";

/**
 * LES ANCIENNES ADRESSES DE « MY CHIEF OF STAFF » — EXÉCUTÉES (Direction, 02/11/2026).
 *
 * Les pages sont appelées pour de vrai : `redirect()` de Next lève son signal, dont la cible est lue dans le `digest`.
 * Le refus d'un non-Super-Admin vient AVANT, du gabarit du segment (`exigerAdamVisible`) — la page n'est jamais rendue
 * pour lui ; ce que ce banc tient, c'est où le Super Admin arrive, paramètres compris.
 */
async function cible(page: (p: { searchParams?: Promise<Record<string, string>> }) => Promise<unknown>, params: Record<string, string> = {}): Promise<string> {
  try {
    await page({ searchParams: Promise.resolve(params) });
  } catch (e) {
    const digest = String((e as { digest?: string }).digest ?? "");
    if (digest.startsWith("NEXT_REDIRECT")) return digest.split(";")[2]!;
    throw e;
  }
  throw new Error("la page n'a pas redirigé");
}

describe("/chief-of-staff → l'écran d'Adam", () => {
  it("la racine mène à la conversation d'Adam ; une question, une référence ou un appel mènent au bureau", async () => {
    expect(await cible(AncienneAdresseChiefOfStaff)).toBe("/assistant");
    expect(await cible(AncienneAdresseChiefOfStaff, { q: "Point du matin" })).toBe("/adam/bureau?q=Point+du+matin");
    expect(await cible(AncienneAdresseChiefOfStaff, { call: "1", ref: "SPO-7" })).toBe("/adam/bureau?call=1&ref=SPO-7");
  });

  it("la boîte et les réglages suivent, avec le retour de la connexion Google", async () => {
    expect(await cible(AncienneAdresseBoiteAdam)).toBe("/adam/boite");
    expect(await cible(AncienneAdresseReglagesAdam, { connecte: "1" })).toBe("/adam/reglages?connecte=1");
    expect(await cible(AncienneAdresseReglagesAdam, { erreur: "refus" })).toBe("/adam/reglages?erreur=refus");
  });
});
