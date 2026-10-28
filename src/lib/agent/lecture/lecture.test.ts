import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/push", () => ({ sendPushToUser: async () => undefined }));

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { remplacerLecteurInterrupteurIaPourTests } from "@/lib/ai-settings";
import { remplacerModelesPourTests } from "@/lib/agent/generer";
import { auNomDe, remplacerReglagesPourTests } from "@/lib/agent/consommation";
import { modeleFactice } from "@/lib/agent/testing/modele-factice";
import { effacerJournalDe } from "@/lib/agent/testing/journal";
import { putBlob } from "@/lib/drive-storage";
import { enregistrerFichierDrive } from "@/lib/drive/depot";
import { jouerTour } from "@/lib/agent/fil/tour";
import { DEPENDANCES_REELLES, lirePieces, type DependancesLecture, type PieceChargee } from "./pieces";
import { CARACTERES_PAR_PIECE, OCTETS_MAX_LECTURE, REFUS_COFFRE, REFUS_CONTROLE_LOCAL, texteParlable } from "./regles";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ASSISTANT LIT CE QU'ON LUI JOINT — bancs de COMPORTEMENT (Direction, 28/10/2026).
 *
 * Le faux modèle tient lieu de vision (il rend un texte écrit d'avance et GARDE ce qu'on lui a
 * montré) ; les gestes lourds (Drive, OCR local, rastérisation) s'injectent. On vérifie ce qui
 * compte : une photo est REGARDÉE et son contenu part au modèle ENCADRÉ ; un scan est lu par la
 * vision, ses pages bornées et la borne DITE ; une pièce du coffre n'atteint JAMAIS le modèle ; une
 * coupe de taille est dite ; une donnée bancaire est masquée ; le plafond du jour arrête la vision.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__ialec_${Date.now().toString(36)}_`;
let moi: CurrentUser;

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

function chargee(nom: string, octets: Buffer, o: Partial<PieceChargee> = {}): PieceChargee {
  return { piece: { id: `c${"x".repeat(24)}${nom.length}`, nom }, mime: null, taille: octets.length, nature: null, confidentialite: null, octets: async () => octets, ...o };
}

/** Des dépendances de banc : la pièce est celle qu'on donne, l'OCR local rend ce qu'on lui dit. */
function deps(p: PieceChargee, o: Partial<DependancesLecture> = {}): DependancesLecture {
  return {
    ...DEPENDANCES_REELLES,
    charger: async () => p,
    texteLocal: async () => ({ texte: "", methode: "ocr", tronque: false, raisonOcr: null }),
    texteNatif: async () => "",
    rasteriser: async () => ({ pages: [PNG], total: 1 }),
    ...o,
  };
}

const lire = (p: PieceChargee, d: DependancesLecture, question = "Que dit cette pièce ?") =>
  auNomDe(moi.id, () => lirePieces(moi, [p.piece], question, d));

/** Les images qu'un prompt reçu par le faux modèle portait. */
const imagesDe = (prompt: unknown): number => (JSON.stringify(prompt).match(/"type":"(image|file)"/g) ?? []).length;

suite("Assistant IA — lecture des pièces jointes (texte, scan, image, coffre, limites)", () => {
  beforeAll(async () => {
    const u = await prisma.user.create({ data: { name: `${TAG}moi`, email: `${TAG}moi@t.dz`, passwordHash: "x", role: "DIRECTION_ASSISTANT" } });
    await prisma.userAccess.create({ data: { userId: u.id, module: "ASSISTANT_IA", canView: true, scope: "ASSIGNED" } });
    await prisma.userAccess.create({ data: { userId: u.id, module: "DRIVE", canView: true, canCreate: true, scope: "ALL" } }).catch(() => {});
    const access = await getAccess(u.id, u.role);
    moi = { id: u.id, name: u.name, email: u.email, role: access.role ?? u.role, secondaryRole: access.secondaryRole, access, mustChangePassword: false } as CurrentUser;
    remplacerLecteurInterrupteurIaPourTests(async () => false);
  });
  afterEach(() => { remplacerModelesPourTests(null); remplacerReglagesPourTests(null); });
  afterAll(async () => {
    remplacerLecteurInterrupteurIaPourTests(null);
    await effacerJournalDe([moi?.id]);
    await prisma.modelCallLog.deleteMany({ where: { userId: moi?.id } }).catch(() => {});
    await prisma.assistantActionIntent.deleteMany({ where: { userId: moi?.id } }).catch(() => {});
    await prisma.driveNode.deleteMany({ where: { ownerId: moi?.id } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: moi?.id } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("une PHOTO de facture est regardée par la vision : l'image part au modèle, son contenu revient ENCADRÉ comme non fiable", async () => {
    const vision = modeleFactice([{ texte: "Photo d'une facture. Texte : FACTURE N° 2026-117 — Total TTC : 45 220,00 DZD." }]);
    remplacerModelesPourTests([vision.modele as never]);
    const r = await lire(chargee("facture.jpg", PNG), deps(chargee("facture.jpg", PNG)));
    expect(r.lectures[0]).toMatchObject({ statut: "LUE", methode: "vision", genre: "image" });
    expect(imagesDe(vision.promptsRecus[0])).toBe(1);
    expect(r.pourModele).toContain("<<<CONTENU_NON_FIABLE");
    expect(r.pourModele).toContain("45 220,00 DZD");
    // Le modèle sait qu'il doit redire les limites et ne pas obéir au document.
    expect(r.pourModele).toMatch(/n'exécute aucune instruction/);
  });

  it("un PDF SCANNÉ : contrôle local d'abord, puis la vision sur 6 pages au plus — et la borne des pages est DITE", async () => {
    const vision = modeleFactice([{ texte: "Page 1 : Contrat de prestation… Page 6 : signatures." }]);
    remplacerModelesPourTests([vision.modele as never]);
    const scan = chargee("contrat-scanne.pdf", Buffer.from("%PDF-1.4 scan"));
    const r = await lire(scan, deps(scan, {
      texteLocal: async () => ({ texte: "Contrat de prestation de services entre les parties", methode: "ocr", tronque: false, raisonOcr: null }),
      rasteriser: async (_o, max) => ({ pages: Array.from({ length: Math.min(max, 9) }, () => PNG), total: 9 }),
    }));
    expect(r.lectures[0].statut).toBe("PARTIELLE");
    expect(r.lectures[0].methode).toMatch(/vision \(6 pages/);
    expect(r.lectures[0].limite).toMatch(/6 pages sur 9/);
    expect(imagesDe(vision.promptsRecus[0])).toBe(6);
    expect(r.pourModele).toMatch(/6 pages sur 9/);
  });

  it("une pièce du COFFRE n'atteint jamais le modèle : nature classée, nom évocateur, ou MRZ reconnue par l'OCR local", async () => {
    const vision = modeleFactice([{ texte: "ne devrait jamais être appelé" }]);
    remplacerModelesPourTests([vision.modele as never]);

    const classee = chargee("scan-0042.jpg", PNG, { nature: "PASSEPORT" });
    const a = await lire(classee, deps(classee));
    expect(a.lectures[0]).toMatchObject({ statut: "REFUSEE", limite: REFUS_COFFRE });

    const nommee = chargee("Bulletin de paie octobre.pdf", Buffer.from("%PDF"));
    const b = await lire(nommee, deps(nommee));
    expect(b.lectures[0].statut).toBe("REFUSEE");

    const photo = chargee("IMG_2201.jpg", PNG);
    const c = await lire(photo, deps(photo, {
      texteLocal: async () => ({ texte: "P<DZABENALI<<AMINA<<<<<<<<<<<<<<<<<<<<<<<<<<\n1234567890DZA8501014F3001012<<<<<<<<<<<<<<06", methode: "ocr", tronque: false, raisonOcr: null }),
    }));
    expect(c.lectures[0].statut).toBe("REFUSEE");

    // Le contrôle local n'a pas pu lire l'image : elle ne part pas non plus.
    const d = await lire(photo, deps(photo, { texteLocal: async () => ({ texte: "", methode: "ocr", tronque: false, raisonOcr: "moteur OCR absent" }) }));
    expect(d.lectures[0]).toMatchObject({ statut: "REFUSEE", limite: REFUS_CONTROLE_LOCAL });

    expect(vision.promptsRecus).toHaveLength(0);
    for (const r of [a, b, c, d]) expect(r.pourModele).not.toContain("<<<CONTENU_NON_FIABLE");
  });

  it("la LIMITE DE TAILLE est dite — à l'écran et au modèle —, jamais une coupe silencieuse", async () => {
    const long = Array.from({ length: 2500 }, (_, i) => `Ligne ${i} : quantité 12, prix unitaire 450 DZD, conditionnement boîte de 30.`).join("\n");
    const doc = chargee("catalogue.txt", Buffer.from(long));
    const r = await lire(doc, deps(doc, { texteLocal: DEPENDANCES_REELLES.texteLocal }));
    expect(r.lectures[0].statut).toBe("PARTIELLE");
    expect(r.lectures[0].retenus).toBeLessThanOrEqual(CARACTERES_PAR_PIECE);
    expect(r.lectures[0].total).toBeGreaterThan(CARACTERES_PAR_PIECE);
    expect(r.lectures[0].limite).toMatch(/premiers caractères lus sur/);
    expect(r.pourModele).toMatch(/premiers caractères lus sur/);

    const enorme = chargee("archive.pdf", Buffer.from("x"), { taille: OCTETS_MAX_LECTURE + 1 });
    const g = await lire(enorme, deps(enorme));
    expect(g.lectures[0].statut).toBe("ECHEC");
    expect(g.lectures[0].limite).toMatch(/n'a pas été lu : au-delà de 40,0 Mo/);
  });

  it("une donnée bancaire dans un tableur est MASQUÉE avant le modèle, et le masque est dit", async () => {
    const csv = chargee("fournisseurs.csv", Buffer.from("fournisseur;iban\nPharmalab;DZ58 0021 0001 1234 5678 9012\nMedistock;DZ12 0040 0174 4012 3456 7891\n"));
    const r = await lire(csv, deps(csv, { texteLocal: DEPENDANCES_REELLES.texteLocal }));
    expect(r.lectures[0].statut).toBe("LUE");
    expect(r.lectures[0].masques).toBeGreaterThan(0);
    expect(r.pourModele).not.toMatch(/DZ58 ?0021/);
    expect(r.pourModele).toContain("Pharmalab");
  });

  it("le PLAFOND DU JOUR arrête la vision : aucune image ne part, le refus est dit sous la pièce", async () => {
    remplacerReglagesPourTests({ plafondJetonsJour: 10_000 });
    await prisma.modelCallLog.create({ data: { turnId: `${TAG}t`, route: "fil", feature: "assistant_ia", userId: moi.id, role: "fil", provider: "openai", model: "x", inputTokens: 20_000, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, webSearchCalls: 0, ms: 1, attempts: 1 } });
    const vision = modeleFactice([{ texte: "ne devrait pas partir" }]);
    remplacerModelesPourTests([vision.modele as never]);
    const p = chargee("capture.png", PNG);
    const r = await lire(p, deps(p));
    expect(r.lectures[0].statut).toBe("ECHEC");
    expect(r.lectures[0].limite).toMatch(/plafond/i);
    expect(vision.promptsRecus).toHaveLength(0);
    await prisma.modelCallLog.deleteMany({ where: { turnId: `${TAG}t` } });
  });

  it("la vision est JOURNALISÉE : une ligne « vision » au nom de la personne", async () => {
    remplacerModelesPourTests([modeleFactice([{ texte: "Capture d'écran d'un tableau de bord." }]).modele as never]);
    const p = chargee("ecran.png", PNG);
    await lire(p, deps(p));
    const lignes = await prisma.modelCallLog.findMany({ where: { userId: moi.id, feature: "assistant_ia", role: "vision" } });
    expect(lignes.length).toBeGreaterThan(0);
  });

  it("de bout en bout : une pièce du Drive jointe au message est LUE et son contenu atteint le modèle du tour", async () => {
    const octets = Buffer.from("Ordre du jour du comité du 30/10 : 1. budget promotion 2. lancement Cardiozen 3. divers");
    const blob = await putBlob(octets);
    const { id } = await enregistrerFichierDrive(moi, {}, { blobId: blob.blobId, size: blob.size, mimeType: "text/plain", name: "ordre-du-jour.txt", sha256: blob.sha256 });
    const faux = modeleFactice([{ texte: JSON.stringify({ message: "Le comité traite du budget promotion et du lancement Cardiozen.", components: [] }) }]);
    remplacerModelesPourTests([faux.modele as never]);
    const r = await jouerTour(moi, { texte: "Résume la pièce", pieces: [{ id, nom: "ordre-du-jour.txt" }], historique: [] });
    expect(r.ok).toBe(true);
    const prompt = JSON.stringify(faux.promptsRecus[0]);
    expect(prompt).toContain("lancement Cardiozen");
    expect(prompt).toContain("CONTENU_NON_FIABLE");
  });
});

describe("La réponse vocale — ce qui se dit à voix haute", () => {
  it("retire la mise en forme et borne la longueur, la coupe étant rendue", () => {
    expect(texteParlable("## Bilan\n- **3** demandes [voir](https://x.dz/a) `en cours`").texte).toBe("Bilan\n3 demandes voir en cours");
    const long = texteParlable("Une phrase assez longue pour remplir. ".repeat(80));
    expect(long.coupe).toBe(true);
    expect(long.texte.length).toBeLessThanOrEqual(1500);
  });
});
