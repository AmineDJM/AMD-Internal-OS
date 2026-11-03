import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelReply } from "@/lib/models/contract";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE BANC DES DEVIS (lot B1, décision 0049) — cinq devis algériens fabriqués en VRAI PDF
 * (`devis-fabriques.ts`), lus par le VRAI point d'entrée (`proposerLecture`) : 100 % des lignes,
 * des totaux et du fournisseur justes.
 *
 * Le monde extérieur est simulé, et lui seul. Le MODÈLE rend, pour INSIGNE, exactement la lecture
 * fautive du 02/11 : fournisseur « ADVENTUM PHARMA », les lignes 4-8, 11-13, 15, 18-20, 24-26
 * absentes et un bloc de trois lignes RÉPÉTÉ (893 500 HT au lieu de 794 500). La VISION (seconde
 * passe) rend la transcription d'un scan. L'OCR local rend du texte abîmé pour le scan.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const modele = vi.hoisted(() => ({ parFichier: new Map<string, unknown>(), appels: 0 }));
vi.mock("@/lib/models/gateway", () => ({
  askModelJson: async (_role: string, prompt: string) => {
    modele.appels++;
    const cle = [...modele.parFichier.keys()].find((k) => prompt.includes(k));
    const reply = { ok: true, configured: true, stop: "end", blocks: [], usage: { role: "worker", model: "modele-du-banc", provider: "openai", inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, costUsd: 0, ms: 1, attempts: 1, reasoningTokens: 0 } } as unknown as ModelReply;
    return { data: cle ? modele.parFichier.get(cle) : null, reply };
  },
}));
vi.mock("@/lib/ai-settings", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai-settings")>()),
  aiFeatureEnabled: async () => true,
  interrupteurIaCoupe: async () => false,
  logAiUsage: async () => {},
}));
vi.mock("@/lib/ai", async (orig) => ({ ...(await orig<typeof import("@/lib/ai")>()), aiConfigured: () => true, cleModeleRequise: () => "OPENAI_API_KEY" }));
// Pas de Luna pour la TRANSCRIPTION du scan : le moteur local (OCR) le lit — mal, comme un vrai OCR de tableau.
vi.mock("@/lib/openai-luna", async (orig) => ({ ...(await orig<typeof import("@/lib/openai-luna")>()), lunaConfigured: () => false }));
vi.mock("@/lib/regulatory/intelligence/ocr/ocr-engine", async (orig) => ({
  ...(await orig<typeof import("@/lib/regulatory/intelligence/ocr/ocr-engine")>()),
  ocrDocument: async () => ({
    engine: "tesseract.js/7", langs: "fra", method: "ocr", meanConfidence: 61, pageCount: 1, lowConfidencePages: 1, needsReview: true, truncated: false, pages: [],
    text: "SIGNA PLUS\nSignalétique et enseignes\nDEVIS N° SP-1145\nClient : PHARMAGÈNE SPA\nNIF : 000909012345678\nN° Désignation Qté P.U. HT Montant HT\n1 Enseigne lumineuse caisson 3 x 0,8 m 1 185 000,00 185 000,00\n2 Plaque PVC 30 x 20 cm bureaux 24 1 800,00 43 200,00\n3 Vitrophanie dépolie salle de réunion 12 3 2O0,00 38 4O0,00\nTotal HT 356 600,00\nTVA 19 % 67 754,00\nTotal TTC 424 354,00\nSIGNA PLUS — RC 16/00-0222111 A 10 — NIF 001016022211133",
  }),
}));
// LA VISION : la transcription du tableau du scan, rendue par le modèle de vision (simulé) — lue par NOTRE code.
const vision = vi.hoisted(() => ({ appels: 0, reponse: null as unknown }));
vi.mock("@/lib/pieces-lues/vision-lignes", async (orig) => {
  const reel = await orig<typeof import("@/lib/pieces-lues/vision-lignes")>();
  return { ...reel, lireTableauParVision: async () => { vision.appels++; return vision.reponse ? reel.lignesDeLaVision(vision.reponse as never, "vision-du-banc") : null; } };
});

import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { proposerLecture, type ContexteLecture } from "../service";
import { BANC_DEVIS, DEVIS_INSIGNE, DEVIS_SCAN, attendu, fichierDuDevis, montantImprime, type DevisFabrique } from "./devis-fabriques";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__bancb1${Date.now().toString(36)}__`;
let USER = { id: "" };

const GROUPE = [
  { id: "adv", noms: ["Adventum Pharma", "Adventum"], nifs: ["001616098765432"], rcs: ["16/00-1234567 B 16"] },
  { id: "phg", noms: ["Pharmagène", "PHG"], nifs: ["000909012345678"], rcs: [] },
  { id: "amd", noms: ["AMD Life Sciences"], nifs: [], rcs: [] },
];
/** L'annuaire de la personne CONTIENT Adventum Pharma (un client, avec son NIF) : le piège du 02/11. */
const CONTEXTE: ContexteLecture = {
  cible: "LEGAL_DOCUMENT", sortieCloudPermise: true,
  annuaireVisible: [{ id: "fiche-adventum", nom: "ADVENTUM PHARMA", nif: "001616098765432" }, { id: "fiche-goodies", nom: "Goodies DZ", nif: "001716077788899" }],
  groupe: { nifs: [], rcs: [], societes: GROUPE },
};
const DEST: Record<string, string> = { [DEVIS_INSIGNE.client.nom]: "adv", "PHARMAGÈNE SPA": "phg", "AMD LIFE SCIENCES": "amd" };

/** La lecture fautive du 02/11, telle que le modèle l'a rendue pour INSIGNE. */
function lectureFautiveInsigne() {
  const a = attendu(DEVIS_INSIGNE).lignes;
  const t = (n: number) => montantImprime(n);
  const l = (n: number) => { const x = a[n - 1]; return { designation: x.designation, reference: "", unite: "", quantite: String(x.qte), prixUnitaire: t(x.pu), remise: "", tva: "19", montantHt: t(x.montant) }; };
  return {
    type: "DEVIS", numero: "DV-2026/318", date: "28/10/2026", devise: "DA", modePaiement: "",
    fournisseur: { nom: "ADVENTUM PHARMA", nif: "001616098765432", rc: "16/00-1234567 B 16", nis: "", ai: "", adresse: "" },
    tvaDefaut: "19", remiseGlobale: "", taxes: [{ libelle: "Taxe publicitaire", taux: "2", montant: "15 890,00" }],
    lignes: [l(2), l(3), l(9), l(10), l(14), l(16), l(17), l(21), l(16), l(17), l(21), l(1), l(22), l(23), l(27)],
    totaux: { ht: "794 500,00", tva: "150 955,00", taxes: "15 890,00", timbre: "", ttc: "961 345,00" },
  };
}

const octets = new Map<string, Buffer>();

suite("Banc B1 — cinq devis réels : 100 % des lignes, des totaux et du fournisseur", () => {
  beforeAll(async () => {
    const u = await prisma.user.create({ data: { id: `${TAG}direction`, name: `${TAG} direction`, email: `${TAG}d@t.dz`, role: "SUPER_ADMIN", passwordHash: "x" } });
    USER = { id: u.id };
    for (const d of BANC_DEVIS) octets.set(d.fichier, await fichierDuDevis(d));
    modele.parFichier.set(DEVIS_INSIGNE.fichier, lectureFautiveInsigne());
  }, 60_000);
  afterAll(async () => {
    const ids = (await prisma.lecturePiece.findMany({ where: { creeParId: USER.id }, select: { id: true } })).map((x) => x.id);
    await prisma.lecturePiece.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });
  beforeEach(() => { vision.appels = 0; vision.reponse = null; });

  const verifier = async (d: DevisFabrique) => {
    const r = await proposerLecture({ user: USER, octets: octets.get(d.fichier)!, nomFichier: d.fichier, contexte: CONTEXTE });
    if (!r.ok) throw new Error(r.error);
    const p = r.proposition;
    const a = attendu(d);
    const lignes = p.piece!.lignes.filter((x) => !x.section);
    expect(lignes.map((x) => [x.designation, x.quantite, x.prixUnitaire, x.montantHt])).toEqual(a.lignes.map((x) => [x.designation, x.qte, x.pu, x.montant]));
    expect(p.reconciliation?.juste, JSON.stringify(p.reconciliation)).toBe(true);
    expect(p.reconciliation?.sommeLignes).toBe(a.ht);
    expect(p.entetes.totalHt?.valeur).toBe(a.ht);
    expect(p.entetes.totalTtc?.valeur).toBe(a.ttc);
    // Les taxes recalculées depuis les lignes font celles du papier : le contrôle est conforme.
    expect(p.controle?.ecarts ?? [], JSON.stringify(p.controle?.ecarts)).toEqual([]);
    // L'ÉMETTEUR est le fournisseur ; le CLIENT est la société du groupe — jamais l'inverse.
    expect(p.emetteur.nom).toBe(d.emetteur.nom);
    expect(p.emetteur.nif).toBe(d.emetteur.nif);
    expect(p.destinataire?.societeId).toBe(DEST[d.client.nom]);
    expect(p.fournisseur.retenu).not.toBe("fiche-adventum");
    return p;
  };

  it("INSIGNE (le devis de la Direction) : le modèle se trompe comme le 02/11 — le tableau lu par ses positions l'emporte", async () => {
    const p = await verifier(DEVIS_INSIGNE);
    expect(p.methodeLignes).toBe("positions");
    expect(p.piece!.lignes).toHaveLength(27);
    expect(p.fournisseur.statut).toBe("AUCUN"); // INSIGNE n'est pas dans l'annuaire : à créer — pas Adventum
    expect(p.fournisseur.aCreer?.nom).toBe("INSIGNE");
    expect(modele.appels, "un tableau qui réconcilie ne paie pas d'appel au modèle").toBe(0);
  });

  it.each(BANC_DEVIS.filter((d) => !d.scan && d !== DEVIS_INSIGNE).map((d) => [d.fichier, d] as const))("%s : lignes, totaux, fournisseur justes", async (_n, d) => {
    const p = await verifier(d);
    expect(p.methodeLignes).toBe("positions");
  });

  it("le GOODIES DZ de l'annuaire est reconnu par son NIF (fiche existante), jamais Adventum", async () => {
    const d = BANC_DEVIS.find((x) => x.emetteur.nom === "GOODIES DZ SARL")!;
    const r = await proposerLecture({ user: USER, octets: octets.get(d.fichier)!, nomFichier: d.fichier, contexte: CONTEXTE });
    if (!r.ok) throw new Error(r.error);
    expect(r.proposition.fournisseur.statut).toBe("CERTAIN");
    expect(r.proposition.fournisseur.retenu).toBe("fiche-goodies");
  });

  it("le SCAN (aucune couche texte) : l'OCR abîme une ligne, la vision la relit — et la réconciliation le prouve", async () => {
    const a = attendu(DEVIS_SCAN);
    // La vision recopie le tableau — en répétant une ligne (pied de page relu) : le dédoublonnage la retire.
    vision.reponse = {
      emetteur: { nom: "SIGNA PLUS", nif: "001016022211133", rc: "" }, client: "PHARMAGÈNE SPA", totalHt: montantImprime(a.ht),
      lignes: [...a.lignes, a.lignes[1]].map((x) => ({ numero: String(x.n), designation: x.designation, quantite: String(x.qte), prixUnitaire: montantImprime(x.pu), montant: montantImprime(x.montant) })),
    };
    const p = await verifier(DEVIS_SCAN);
    expect(p.methodeLignes).toBe("vision");
    expect(vision.appels).toBe(1);
  });
});
