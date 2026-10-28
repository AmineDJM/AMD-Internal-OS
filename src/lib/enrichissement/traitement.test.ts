import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { prisma } from "@/lib/prisma";
import { chiffreDeControle } from "@/lib/agent/operations/mrz";
import { clesDepuisMaitresse } from "@/modules/coffre/api";
import { persistUploadedDocument } from "@/lib/documents";
import { releaseBlob } from "@/lib/drive-storage";
import type { MoteurOcr } from "@/lib/regulatory/intelligence/extract/texte-ou-ocr";
import { traiterLaFile, traiterTache, type DependancesChaine } from "./traitement";
import { confirmerFaitPropose, trancherConflitDeFait } from "./confirmation";

/**
 * LE LIVRABLE DU LOT V2-A, BOUT EN BOUT, AVEC LA VRAIE BASE ET LE VRAI GOULOT.
 *
 *   - un passeport déposé sur un poste billetterie, à l'étape d'un voyageur, propose nom / prénoms /
 *     nationalité sur la Personne du voyageur et range le numéro au coffre — sans jamais l'écrire en clair ;
 *   - rejouer (même dépôt, même tâche) ne duplique rien ;
 *   - une pièce de paie est lue sur ce serveur seulement : OCR appelé `cloud: false`, aucun appel réseau ;
 *   - un second passeport qui contredit un nom confirmé ouvre un conflit, tranché sans rien effacer.
 *
 * L'OCR est injecté (pas de données de langue en test) : c'est lui qui « lit » l'image déposée, et c'est
 * lui qui prouve ce que la chaîne lui demande.
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }

const TAG = `__enrich__${Date.now().toString(36)}`;
const c = (s: string) => String(chiffreDeControle(s));
/** Une MRZ TD3 cohérente (chiffres de contrôle calculés) — données fictives. */
function td3(nom: string, prenoms: string, numero: string, naissance: string, expiration: string): string {
  const l1 = `P<DZA${nom}<<${prenoms.replace(/ /g, "<")}`.padEnd(44, "<");
  const num = numero.padEnd(9, "<");
  const perso = "".padEnd(14, "<");
  const corps = `${num}${c(num)}DZA${naissance}${c(naissance)}M${expiration}${c(expiration)}${perso}${c(perso)}`;
  const composite = corps.slice(0, 10) + corps.slice(13, 20) + corps.slice(21, 43);
  return `RÉPUBLIQUE ALGÉRIENNE DÉMOCRATIQUE ET POPULAIRE\nPASSEPORT / PASSPORT\n${l1}\n${corps}${c(composite)}`;
}
const NUMERO = `${Math.floor(100000000 + Math.random() * 899999999)}`;
const PASSEPORT = td3("BENALI", "KARIM", NUMERO, "840412", "310915");
const PASSEPORT_BIS = td3("BENALLI", "KARIM", NUMERO, "840412", "310915");
const PAIE = "ADVENTUM PHARMA SPA\nBULLETIN DE PAIE\nPériode de paie : octobre 2026\nMatricule : 0042\nSalaire de base 80 000,00\nRetenue SS 9 % 7 200,00\nIRG 9 800,00\nNet à payer 63 000,00";

/** Un OCR de test : rend le texte associé aux octets, et note ce qu'on lui a demandé. */
const appelsOcr: { cloud: boolean | undefined }[] = [];
const textes = new Map<string, string>();
const ocr: MoteurOcr = async ({ buffer, cloud }) => {
  appelsOcr.push({ cloud });
  const text = textes.get(crypto.createHash("sha256").update(buffer).digest("hex")) ?? "";
  return { text, meanConfidence: 92, needsReview: false, pageCount: 1, pagesLues: 1, moteur: "ocr-de-test" };
};
const deps: DependancesChaine = { ocr, cles: () => clesDepuisMaitresse(crypto.createHash("sha256").update("cle-du-banc-enrichissement").digest(), true) };

/** Une « image » unique dont l'OCR de test rendra `texte`. */
function image(nom: string, texte: string): File {
  const octets = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(64)]);
  textes.set(crypto.createHash("sha256").update(octets).digest("hex"), texte);
  return new File([octets], nom, { type: "image/png" });
}

let userId = "";
let itemId = "";
let eventId = "";
let voyageurId = "";
let actifAvant = false;
const blobs = new Set<string>();

async function tachesDuDocument(documentId: string) {
  const doc = await prisma.document.findUniqueOrThrow({ where: { id: documentId }, select: { entityId: true } });
  const duDocument = await prisma.tacheEnrichissement.findMany({ where: { rattachementId: documentId }, select: { empreinte: true } });
  const empreintes = duDocument.map((t) => t.empreinte).filter((e): e is string => !!e);
  return prisma.tacheEnrichissement.findMany({
    where: { rattachementId: { in: [documentId, doc.entityId] }, empreinte: { in: empreintes } },
    orderBy: { rattachementType: "asc" },
  });
}

async function deposer(file: File, cible: { entityType: "AD_PRO_ITEM" | "EMPLOYEE"; entityId: string; stepKey: string | null; category: "ID_DOCUMENT" | "OTHER" }) {
  const r = await persistUploadedDocument(userId, { ...cible, confidentiality: "INTERNAL", file, mirrorToDrive: false });
  expect(r.ok).toBe(true);
  const taches = await tachesDuDocument(r.documentId!);
  taches.forEach((t) => blobs.add(t.blobId));
  return { documentId: r.documentId!, taches };
}

describe.skipIf(!dbOk)("enrichissement — du dépôt au fait (lot V2-A)", () => {
  beforeAll(async () => {
    actifAvant = (await prisma.appSetting.findUnique({ where: { id: "global" }, select: { enrichissementActif: true } }))?.enrichissementActif ?? false;
    await prisma.appSetting.upsert({ where: { id: "global" }, create: { id: "global", enrichissementActif: true }, update: { enrichissementActif: true } });
    userId = (await prisma.user.create({ data: { name: `${TAG}dépositaire`, email: `${TAG}@t.dz`, role: "VIEWER", passwordHash: "x" }, select: { id: true } })).id;
    eventId = (await prisma.event.create({ data: { name: `${TAG}Congrès` }, select: { id: true } })).id;
    itemId = (await prisma.adProItem.create({ data: { eventId, kind: "TICKETING", label: `${TAG}Billets Paris` }, select: { id: true } })).id;
    voyageurId = (await prisma.adProVoyageur.create({ data: { itemId, nom: "Benali", prenom: "Karim" }, select: { id: true } })).id;
  });

  afterAll(async () => {
    await prisma.appSetting.update({ where: { id: "global" }, data: { enrichissementActif: actifAvant } }).catch(() => undefined);
    const taches = await prisma.tacheEnrichissement.findMany({ where: { deposeParId: userId }, select: { empreinte: true } });
    const empreintes = taches.map((t) => t.empreinte).filter((e): e is string => !!e);
    const pieces = await prisma.piece.findMany({ where: { empreinte: { in: empreintes } }, select: { id: true } });
    const voyageur = await prisma.adProVoyageur.findUnique({ where: { id: voyageurId }, select: { personneId: true } });
    await prisma.conflitDeFait.deleteMany({ where: { faitPropose: { extraction: { pieceId: { in: pieces.map((p) => p.id) } } } } });
    await prisma.faitConfirme.deleteMany({ where: { pieceId: { in: pieces.map((p) => p.id) } } });
    await prisma.donneeSensible.deleteMany({ where: { pieceId: { in: pieces.map((p) => p.id) } } });
    await prisma.document.deleteMany({ where: { uploadedById: userId } });
    await prisma.piece.deleteMany({ where: { id: { in: pieces.map((p) => p.id) } } });
    await prisma.tacheEnrichissement.deleteMany({ where: { deposeParId: userId } });
    await prisma.businessEvent.deleteMany({ where: { correlationId: { in: empreintes.map((e) => `piece:${e}`) } } });
    await prisma.event.delete({ where: { id: eventId } }).catch(() => undefined);
    if (voyageur?.personneId) await prisma.personne.delete({ where: { id: voyageur.personneId } }).catch(() => undefined);
    await prisma.auditLog.deleteMany({ where: { actorId: userId } });
    await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    for (const b of blobs) await releaseBlob(b).catch(() => undefined);
  });

  let documentPasseport = "";
  let personneId = "";

  it("un passeport déposé sur le poste, au nom du voyageur, propose l'état civil et range le numéro au coffre", async () => {
    const { documentId, taches } = await deposer(image("passeport_benali.png", PASSEPORT), { entityType: "AD_PRO_ITEM", entityId: itemId, stepKey: voyageurId, category: "ID_DOCUMENT" });
    documentPasseport = documentId;
    // Le goulot a mis en file la fiche du poste ET le document, sous le nom réduit (pièce d'identité → confidentielle).
    expect(taches.map((t) => t.rattachementType).sort()).toEqual(["AD_PRO_ITEM", "DOCUMENT"]);
    expect(taches.every((t) => t.nomFichier === "*.png" && t.confidentiality === "CONFIDENTIAL")).toBe(true);

    for (const t of taches) expect((await traiterTache(t, deps)).statut).toBe("FAITE");

    const voyageur = await prisma.adProVoyageur.findUniqueOrThrow({ where: { id: voyageurId }, select: { personneId: true } });
    expect(voyageur.personneId).toBeTruthy();
    personneId = voyageur.personneId!;
    const piece = await prisma.piece.findFirstOrThrow({ where: { documents: { some: { id: documentId } } }, select: { id: true, nature: true, confidentiality: true } });
    expect(piece.nature).toBe("PASSEPORT");
    expect(piece.confidentiality).toBe("CONFIDENTIAL");

    const faits = await prisma.faitPropose.findMany({ where: { extraction: { pieceId: piece.id } } });
    const de = (a: string) => faits.find((f) => f.attribut === a);
    for (const a of ["personne.nom", "personne.prenoms", "personne.nationalite"]) {
      expect(de(a)?.sujetId).toBe(personneId);
      expect(de(a)?.decision).toBe("EN_ATTENTE"); // proposé, jamais confirmé d'office (état civil)
    }
    expect(de("personne.nom")?.valeurNormalisee).toMatch(/benali/i);
    expect(de("personne.nationalite")?.valeurNormalisee).toBe("DZA");

    // Le numéro : au coffre, pour cette personne, et nulle part en clair.
    const numero = de("personne.passeport.numero");
    expect(numero?.decision).toBe("COFFRE");
    expect(numero?.valeur).toBeNull();
    const coffre = await prisma.donneeSensible.findMany({ where: { titulaireType: "PERSONNE", titulaireId: personneId, nature: "PASSEPORT_NUMERO" } });
    expect(coffre).toHaveLength(1);
    expect(coffre[0].derniersCaracteres).toBe(NUMERO.slice(-4));
    expect(numero?.donneeSensibleId).toBe(coffre[0].id);
    const traces = JSON.stringify([
      faits, await prisma.tacheEnrichissement.findMany({ where: { deposeParId: userId } }),
      await prisma.businessEvent.findMany({ where: { type: "PIECE_DEPOSEE", actorId: userId } }), coffre.map((d) => d.valeurChiffree.toString("utf8")),
    ]);
    expect(traces).not.toContain(NUMERO);

    // La pièce apparaît sur la fiche de la personne, et le document la désigne.
    expect(await prisma.pieceLien.count({ where: { pieceId: piece.id, sujetType: "PERSONNE", sujetId: personneId } })).toBe(1);
    // L'OCR n'a été appelé qu'en local.
    expect(appelsOcr.length).toBeGreaterThan(0);
    expect(appelsOcr.every((a) => a.cloud === false)).toBe(true);
  });

  it("rejouer — le même dépôt, les mêmes tâches — ne duplique rien", async () => {
    const piece = await prisma.piece.findFirstOrThrow({ where: { documents: { some: { id: documentPasseport } } }, select: { id: true, empreinte: true } });
    const compter = async () => ({
      pieces: await prisma.piece.count({ where: { empreinte: piece.empreinte } }),
      liens: await prisma.pieceLien.count({ where: { pieceId: piece.id } }),
      extractions: await prisma.extraction.count({ where: { pieceId: piece.id } }),
      faits: await prisma.faitPropose.count({ where: { extraction: { pieceId: piece.id } } }),
      coffre: await prisma.donneeSensible.count({ where: { titulaireId: personneId } }),
      personnes: await prisma.personne.count({ where: { adProVoyageurs: { some: { id: voyageurId } } } }),
      taches: await prisma.tacheEnrichissement.count({ where: { empreinte: piece.empreinte } }),
      faitsPublies: await prisma.businessEvent.count({ where: { correlationId: `piece:${piece.empreinte}` } }),
    });
    const avant = await compter();
    for (const t of await tachesDuDocument(documentPasseport)) await traiterTache(t, deps);
    expect(await compter()).toEqual(avant);
  });

  it("une pièce de paie est lue sur ce serveur seulement — aucun appel réseau, OCR local, extraction locale", async () => {
    const fetchEspion = vi.spyOn(globalThis, "fetch");
    appelsOcr.length = 0;
    try {
      const { taches } = await deposer(image("paie_octobre.png", PAIE), { entityType: "EMPLOYEE", entityId: `${TAG}salarie`, stepKey: null, category: "OTHER" });
      expect(taches.every((t) => t.confidentiality === "CONFIDENTIAL" && t.nomFichier === "*.png")).toBe(true);
      for (const t of taches) await traiterTache(t, deps);
      expect(fetchEspion).not.toHaveBeenCalled();
      expect(appelsOcr.length).toBeGreaterThan(0);
      expect(appelsOcr.every((a) => a.cloud === false)).toBe(true);
      const piece = await prisma.piece.findUniqueOrThrow({ where: { id: `piece_${taches[0].empreinte}` }, select: { nature: true, extractions: { select: { local: true } } } });
      expect(piece.nature).toBe("BULLETIN_PAIE");
      expect(piece.extractions.every((e) => e.local)).toBe(true);
    } finally {
      fetchEspion.mockRestore();
    }
  });

  it("un nom confirmé que contredit un second passeport ouvre un conflit, tranché sans rien effacer", async () => {
    const nom = await prisma.faitPropose.findFirstOrThrow({ where: { sujetId: personneId, attribut: "personne.nom", decision: "EN_ATTENTE" }, select: { id: true, valeur: true } });
    expect((await confirmerFaitPropose(nom.id, { parId: userId, decision: "CONFIRME", raison: "banc" })).ok).toBe(true);
    expect((await prisma.personne.findUniqueOrThrow({ where: { id: personneId } })).nom).toBe(nom.valeur);

    const { taches } = await deposer(image("passeport_bis.png", PASSEPORT_BIS), { entityType: "AD_PRO_ITEM", entityId: itemId, stepKey: voyageurId, category: "ID_DOCUMENT" });
    for (const t of taches) await traiterTache(t, deps);
    const conflit = await prisma.conflitDeFait.findFirstOrThrow({ where: { sujetId: personneId, attribut: "personne.nom", statut: "OUVERT" } });
    expect(conflit.valeurProposee?.toUpperCase()).toBe("BENALLI");
    // Même numéro de passeport : déjà au coffre, pas de seconde ligne.
    expect(await prisma.donneeSensible.count({ where: { titulaireId: personneId, nature: "PASSEPORT_NUMERO" } })).toBe(1);

    expect((await trancherConflitDeFait(conflit.id, { parId: userId, choix: "REMPLACER", commentaire: null })).ok).toBe(true);
    const historique = await prisma.faitConfirme.findMany({ where: { sujetId: personneId, attribut: "personne.nom" }, orderBy: { confirmeLe: "asc" } });
    expect(historique.map((h) => [h.valeur?.toUpperCase(), h.actif])).toEqual([["BENALI", false], ["BENALLI", true]]);
    expect((await prisma.personne.findUniqueOrThrow({ where: { id: personneId } })).nom).toBe(conflit.valeurProposee);
  });

  it("interrupteur fermé : aucun dépôt n'est mis en file, aucun passage ne travaille", async () => {
    await prisma.appSetting.update({ where: { id: "global" }, data: { enrichissementActif: false } });
    try {
      const { taches } = await deposer(image("ferme.png", PASSEPORT), { entityType: "AD_PRO_ITEM", entityId: itemId, stepKey: null, category: "ID_DOCUMENT" });
      expect(taches).toHaveLength(0);
      expect((await traiterLaFile({ max: 5 })).actif).toBe(false);
    } finally {
      await prisma.appSetting.update({ where: { id: "global" }, data: { enrichissementActif: true } });
    }
  });
});
