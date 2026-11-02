/**
 * LE BANC D'AUDIT — LOT T2 (décision 0052) : les constantes PURES partagées par le semis (`annuaire-marketing-semis.ts`,
 * qui écrit en base) et le catalogue des tâches (`annuaire-marketing.ts`, pur) — aucun import.
 */
export const TEMOIN_VISITE = "QZ-VISITE-YAN-7731";
export const etiquetteT2 = (etiquette: string) => `[banc T2${etiquette}]`;

/** L'état initial des fiches que les tâches modifient — remis par `preparer`. */
export const INITIAL = {
  bensalem: { phone: "0550 00 00 01" },
  elAmel: { address: "5 rue Larbi Ben M'hidi, Oran", phone: "041 30 11 22" },
  belleVue: { phone: "041 39 00 00" },
  esSalamA: { name: "Pharmacie Es-Salam", phone: "041 28 76 54", address: null as string | null },
  esSalamB: { name: "PHARMACIE ES SALAM", phone: null as string | null, address: "9 avenue de l'ALN, Oran" },
  omarBenali: { institution: "Clinique El Hayat" },
  fournisseur: { website: "www.hetero-old.example" },
} as const;

