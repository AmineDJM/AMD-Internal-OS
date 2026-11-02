import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { extname } from "node:path";
import type { Prisma } from "@prisma/client";
import type { MoteurOcr } from "@/lib/regulatory/intelligence/extract/texte-ou-ocr";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UNE PIÈCE N'EST LUE QU'UNE FOIS — par l'empreinte de ses octets (lot D2-A, P6).
 *
 * Joué sur la vraie base locale, par le vrai point d'entrée (`lireFichierUneFois`). Aucun vrai
 * OCR : chaque cas INJECTE son moteur, et le moteur de production est remplacé par un piège qui
 * lève — un cas qui l'atteindrait le dirait. Ce que chaque cas protège :
 *   • la clé est l'EMPREINTE des octets : deux noms, une lecture ; deux contenus, deux lectures ;
 *   • on RÉSERVE avant de lire : deux dépôts simultanés font tourner le moteur une fois (§118.65) ;
 *   • une réservation abandonnée se reprend, SOUS CONDITION — deux reprises forcées à se croiser
 *     ne lisent pas deux fois ; une réservation fraîche ne se reprend pas ;
 *   • la conclusion appartient à la tentative qui tient la réservation : un lecteur dépossédé
 *     n'écrase pas la lecture de celui qui l'a remplacé ;
 *   • un échec n'est pas un acquis (§118.105a) — mais qui l'attendait en partage l'issue ;
 *   • le texte dort SCELLÉ, et l'OCR reste local sauf demande expresse.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

// Le piège : le moteur OCR de PRODUCTION ne doit jamais tourner dans ce banc.
const production = vi.hoisted(() => ({
  ocrDocument: vi.fn(async () => { throw new Error("moteur OCR de production appelé dans un banc"); }),
}));
vi.mock("@/lib/regulatory/intelligence/ocr/ocr-engine", async (importOriginal) => {
  const reel = await importOriginal<typeof import("@/lib/regulatory/intelligence/ocr/ocr-engine")>();
  return { ...reel, ocrDocument: production.ocrDocument };
});

// Un fichier « piégé » fait planter l'extraction elle-même — une fois, après un temps (pour que l'autre appel
// l'ATTENDE) : c'est le lecteur qui tombe, pas l'OCR.
const piege = vi.hoisted(() => ({ restants: 0 }));
vi.mock("@/lib/regulatory/intelligence/extract/extract-text", async (importOriginal) => {
  const reel = await importOriginal<typeof import("@/lib/regulatory/intelligence/extract/extract-text")>();
  return {
    ...reel,
    extractText: async (ext: string, buffer: Buffer) => {
      if (buffer.includes("LECTEUR-PIEGE") && piege.restants > 0) {
        piege.restants -= 1;
        await new Promise((r) => setTimeout(r, 300));
        throw new Error("extraction impossible : fichier piégé");
      }
      return reel.extractText(ext, buffer);
    },
  };
});

import { prisma } from "@/lib/prisma";
import { openSecret } from "@/lib/crypto/secret-box";
import { empreinteDe, lireFichierUneFois, VERSION_LECTEUR, type ResultatLecture } from "./lecture-fichier";

const TAG = `__lectfich${Date.now()}__`;
const UTILISATEUR = `${TAG}-u`;
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TEXTE = "DEVIS N° DV-2026-0418 du 12 septembre 2026 — Imprimerie du Banc SARL. Fiche posologique, "
  + "quantité 2 000, prix unitaire 42,50. Total HT 85 000,00 ; TVA 19 % 16 150,00 ; Total TTC 101 150,00.";

/** Des octets propres au banc (le TAG les rend uniques d'un passage à l'autre). */
const octets = (s: string): Buffer => Buffer.from(`${TAG}|${s}`, "utf8");
const extDe = (nomFichier: string): string => extname(nomFichier).slice(1);
const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Lu = Awaited<ReturnType<MoteurOcr>>;
const lu = (texte: string, over: Partial<Lu> = {}): Lu =>
  ({ text: texte, meanConfidence: 71.4, needsReview: false, pageCount: 2, pagesLues: 2, moteur: "tesseract.js/7", ...over });

/** Un moteur qui lit `texte`, après un délai. */
const moteur = (texte: string, delaiMs = 0) => vi.fn<MoteurOcr>(async () => { if (delaiMs) await dormir(delaiMs); return lu(texte); });

/** Un moteur qui ne rend la main que lorsqu'on le relâche — pour tenir une tentative ouverte. */
function moteurTenu(texte: string) {
  let relacher!: () => void;
  const relache = new Promise<void>((r) => { relacher = r; });
  const fn = vi.fn<MoteurOcr>(async () => { await relache; return lu(texte); });
  return { fn, relacher };
}

async function jusqua(cond: () => boolean, quoi: string): Promise<void> {
  const debut = Date.now();
  while (!cond()) {
    if (Date.now() - debut > 15_000) throw new Error(`attente dépassée : ${quoi}`);
    await dormir(10);
  }
}

function lecture(r: ResultatLecture) {
  if (!r.ok) throw new Error(`lecture attendue, reçu ${r.code} : ${r.message}`);
  return r.lecture;
}

const lignesDe = (o: Buffer) =>
  prisma.lecturePiece.findMany({ where: { empreinte: empreinteDe(o), versionLecteur: VERSION_LECTEUR } });

/** Une ligne posée à la main, comme l'aurait laissée une tentative ancienne. */
const poser = (o: Buffer, data: Partial<Prisma.LecturePieceUncheckedCreateInput>) =>
  prisma.lecturePiece.create({
    data: { empreinte: empreinteDe(o), versionLecteur: VERSION_LECTEUR, extension: "png", taille: o.length, creeParId: UTILISATEUR, ...data },
  });

/**
 * DEUX REPRISES FORCÉES À SE CROISER (§118.164e) : le banc verrouille la ligne, les deux appels la
 * LISENT périmée puis butent ensemble sur son verrou en voulant la reprendre ; la barrière attend
 * qu'ils soient DEUX à attendre à l'écriture, puis relâche. Sans la condition de reprise, les deux
 * passeraient — et liraient deux fois.
 */
async function deuxReprisesEnsemble<T>(id: string, a: () => Promise<T>, b: () => Promise<T>): Promise<[T, T]> {
  let ga: Promise<T> | null = null, gb: Promise<T> | null = null;
  try {
    await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT 1 FROM "LecturePiece" WHERE id = $1 FOR UPDATE`, id);
      ga = a(); gb = b();
      ga.catch(() => undefined); gb.catch(() => undefined);
      const debut = Date.now();
      for (;;) {
        await tx.$executeRawUnsafe("SELECT pg_stat_clear_snapshot()");
        const [{ n }] = await tx.$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()
            AND wait_event_type = 'Lock' AND query ILIKE 'UPDATE%' AND query ILIKE '%"LecturePiece"%'`;
        if (n >= 2) break;
        if (Date.now() - debut > 30_000) throw new Error("les deux reprises n'ont pas atteint la barrière");
        await dormir(25);
      }
    }, { timeout: 60_000 });
  } catch (e) {
    // La barrière n'a pas tenu : on laisse les deux lectures finir avant de rendre la main — elles ne
    // doivent pas réserver à nouveau une fois le banc nettoyé.
    await Promise.allSettled([ga, gb]);
    throw e;
  }
  return Promise.all([ga!, gb!]);
}

/**
 * Ce que CE passage a semé — et les restes d'un passage interrompu (plus de dix minutes) : jamais les lignes
 * fraîches d'un autre passage du même banc, qui tournerait à côté.
 */
async function nettoyer() {
  const where: Prisma.LecturePieceWhereInput = {
    OR: [
      { creeParId: { startsWith: TAG } },
      { creeParId: { startsWith: "__lectfich" }, createdAt: { lt: new Date(Date.now() - 10 * 60_000) } },
    ],
  };
  const ids = (await prisma.lecturePiece.findMany({ where, select: { id: true } })).map((x) => x.id);
  await prisma.lecturePieceConfirmation.deleteMany({ where: { lectureId: { in: ids } } });
  await prisma.lecturePiece.deleteMany({ where: { id: { in: ids } } });
}

describe("l'empreinte d'une pièce", () => {
  it("est le SHA-256 hexadécimal de ses octets — et d'eux seuls", () => {
    expect(empreinteDe(Buffer.from("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    const o = octets("empreinte");
    expect(empreinteDe(o)).toBe(createHash("sha256").update(o).digest("hex"));
    expect(empreinteDe(octets("empreinte-bis"))).not.toBe(empreinteDe(o));
  });
});

suite("une pièce n'est lue qu'une fois — par l'empreinte de ses octets", () => {
  beforeAll(nettoyer);
  afterAll(async () => {
    await nettoyer();
    // Aucun cas n'a atteint le moteur de production : tous ont injecté le leur.
    expect(production.ocrDocument).not.toHaveBeenCalled();
  });

  it("mêmes octets sous deux noms : le moteur une seule fois, la même lecture", async () => {
    const o = octets("devis-kwality");
    const m = moteur(TEXTE);
    const a = lecture(await lireFichierUneFois({ octets: o, ext: extDe("Devis Kwality.png"), userId: UTILISATEUR }, { ocr: m }));
    const b = lecture(await lireFichierUneFois({ octets: Buffer.from(o), ext: extDe("SCAN_0042.PNG"), userId: UTILISATEUR }, { ocr: m }));
    expect(m).toHaveBeenCalledTimes(1);
    expect(b.id).toBe(a.id);
    expect([a.luParCetAppel, b.luParCetAppel]).toEqual([true, false]);
    // Servie depuis la base, la lecture dit la même chose que celle qui vient de tourner.
    for (const l of [a, b]) {
      expect(l).toMatchObject({ etat: "LUE", texte: TEXTE, methode: "ocr", confiance: 71, moteur: "tesseract.js/7", extension: "png", taille: o.length, pagesLues: 2, pagesTotal: 2, caracteres: TEXTE.length });
    }
    expect(await lignesDe(o)).toHaveLength(1);
  });

  it("octets différents sous le même nom : deux lectures, chacune la sienne", async () => {
    const m = vi.fn<MoteurOcr>(async ({ buffer }) => lu(`LU ${buffer.toString("utf8")}`));
    const v1 = octets("devis-v1"), v2 = octets("devis-v2");
    const a = lecture(await lireFichierUneFois({ octets: v1, ext: extDe("devis.png"), userId: UTILISATEUR }, { ocr: m }));
    const b = lecture(await lireFichierUneFois({ octets: v2, ext: extDe("devis.png"), userId: UTILISATEUR }, { ocr: m }));
    expect(m).toHaveBeenCalledTimes(2);
    expect(b.id).not.toBe(a.id);
    expect(a.texte).toBe(`LU ${v1.toString("utf8")}`);
    expect(b.texte).toBe(`LU ${v2.toString("utf8")}`);
  });

  it("deux lectures neuves lancées ensemble : le moteur une seule fois, la même lecture", async () => {
    const o = octets("deux-ensemble");
    const m = moteur(TEXTE, 300);
    const [a, b] = await Promise.all([
      lireFichierUneFois({ octets: o, ext: "png", userId: UTILISATEUR }, { ocr: m, intervalleMs: 25 }),
      lireFichierUneFois({ octets: o, ext: "png", userId: UTILISATEUR }, { ocr: m, intervalleMs: 25 }),
    ]);
    expect(m).toHaveBeenCalledTimes(1);
    expect(lecture(b).id).toBe(lecture(a).id);
    expect([lecture(a).luParCetAppel, lecture(b).luParCetAppel].sort()).toEqual([false, true]);
    expect(lecture(b).texte).toBe(TEXTE);
    expect(await lignesDe(o)).toHaveLength(1);
  }, 30_000);

  it("une réservation abandonnée (EN_COURS depuis plus de 5 minutes) se reprend : la même ligne, lue", async () => {
    const o = octets("reservation-abandonnee");
    const posee = await poser(o, { etat: "EN_COURS", updatedAt: new Date(Date.now() - 6 * 60_000) });
    const m = moteur(TEXTE);
    const l = lecture(await lireFichierUneFois({ octets: o, ext: "png", userId: UTILISATEUR }, { ocr: m, attenteMaxMs: 2_000 }));
    expect(m).toHaveBeenCalledTimes(1);
    expect(l.id).toBe(posee.id);
    expect(l.luParCetAppel).toBe(true);
    expect((await prisma.lecturePiece.findUniqueOrThrow({ where: { id: posee.id } })).etat).toBe("LUE");
  });

  it("une réservation FRAÎCHE ne se reprend pas : on attend son issue, puis on dit qu'elle est en cours", async () => {
    const o = octets("reservation-fraiche");
    const posee = await poser(o, { etat: "EN_COURS", updatedAt: new Date() });
    const m = moteur(TEXTE);
    const r = await lireFichierUneFois({ octets: o, ext: "png", userId: UTILISATEUR }, { ocr: m, attenteMaxMs: 400, intervalleMs: 50 });
    expect(m).not.toHaveBeenCalled();
    expect(r).toEqual({
      ok: false, code: "EN_COURS", lectureId: posee.id,
      message: "Cette pièce est déjà en cours de lecture — relancez dans quelques secondes : elle ne sera pas lue une seconde fois, son résultat vous sera rendu.",
    });
    expect((await prisma.lecturePiece.findUniqueOrThrow({ where: { id: posee.id } })).etat).toBe("EN_COURS");
  });

  it("deux reprises simultanées d'une réservation abandonnée : le moteur une seule fois", async () => {
    const o = octets("deux-reprises");
    const posee = await poser(o, { etat: "EN_COURS", updatedAt: new Date(Date.now() - 6 * 60_000) });
    const m = moteur(TEXTE, 200);
    const [a, b] = await deuxReprisesEnsemble(posee.id,
      () => lireFichierUneFois({ octets: o, ext: "png", userId: UTILISATEUR }, { ocr: m, intervalleMs: 25 }),
      () => lireFichierUneFois({ octets: o, ext: "png", userId: UTILISATEUR }, { ocr: m, intervalleMs: 25 }));
    expect(m).toHaveBeenCalledTimes(1);
    expect([lecture(a).id, lecture(b).id]).toEqual([posee.id, posee.id]);
    expect([lecture(a).luParCetAppel, lecture(b).luParCetAppel].sort()).toEqual([false, true]);
  }, 90_000);

  it("une tentative dépossédée ne conclut pas : la lecture de celle qui l'a remplacée fait foi, pour tous", async () => {
    const o = octets("depossedee");
    const A = moteurTenu("TEXTE LU PAR LA TENTATIVE A, CRUE MORTE");
    const B = moteurTenu("TEXTE LU PAR LA TENTATIVE B, QUI L'A REMPLACÉE");
    // A réserve, puis reste dans le moteur…
    const pa = lireFichierUneFois({ octets: o, ext: "png", userId: UTILISATEUR }, { ocr: A.fn, intervalleMs: 25 });
    let pb: Promise<ResultatLecture> | null = null;
    try {
      await jusqua(() => A.fn.mock.calls.length === 1, "la tentative A lit");
      // … assez longtemps pour que B la croie abandonnée et la reprenne.
      pb = lireFichierUneFois({ octets: o, ext: "png", userId: UTILISATEUR }, { ocr: B.fn, perimeApresMs: 50, intervalleMs: 25 });
      await jusqua(() => B.fn.mock.calls.length === 1, "la tentative B a repris et lit");
      // A finit APRÈS coup : sa conclusion ne lui appartient plus.
      A.relacher();
      await dormir(150);
    } finally {
      // Quoi qu'il arrive, aucune lecture ne reste suspendue après le cas : elle réserverait à nouveau
      // une fois le banc nettoyé, et laisserait une ligne derrière lui.
      A.relacher();
      B.relacher();
      await Promise.allSettled([pa, pb]);
    }
    const [a, b] = await Promise.all([pa, pb!]);
    const voulu = "TEXTE LU PAR LA TENTATIVE B, QUI L'A REMPLACÉE";
    expect(lecture(b)).toMatchObject({ texte: voulu, luParCetAppel: true });
    expect(lecture(a)).toMatchObject({ id: lecture(b).id, texte: voulu, luParCetAppel: false });
    const ligne = (await lignesDe(o))[0]!;
    expect(openSecret(ligne.texteScelle)).toBe(voulu);
  }, 60_000);

  it("un échec d'OCR n'est pas un acquis : l'appel suivant relit, sous la même ligne", async () => {
    const o = octets("ocr-tombe");
    const ko = vi.fn<MoteurOcr>(async () => { throw new Error("Tesseract : le worker est tombé"); });
    const r1 = lecture(await lireFichierUneFois({ octets: o, ext: "png", userId: UTILISATEUR }, { ocr: ko }));
    expect(r1).toMatchObject({ etat: "ECHOUEE", ocrTente: true, ocrEchoue: true, texte: "", luParCetAppel: true });
    expect(r1.raisonOcr).toContain("le worker est tombé");
    expect((await prisma.lecturePiece.findUniqueOrThrow({ where: { id: r1.id } })).etat).toBe("ECHOUEE");

    const ok = moteur(TEXTE);
    const r2 = lecture(await lireFichierUneFois({ octets: o, ext: "png", userId: UTILISATEUR }, { ocr: ok }));
    expect(ok).toHaveBeenCalledTimes(1);
    expect(r2).toMatchObject({ id: r1.id, etat: "LUE", texte: TEXTE, ocrEchoue: false, luParCetAppel: true });
  });

  it("qui attendait une tentative en partage l'échec : deux dépôts simultanés d'un scan illisible, le moteur une seule fois", async () => {
    const o = octets("ocr-tombe-ensemble");
    // La lecture dure assez pour que le second dépôt la trouve EN COURS même quand la suite complète charge la
    // machine (à 300 ms, le second arrivait parfois après l'échec conclu et retentait, à bon droit).
    const ko = vi.fn<MoteurOcr>(async () => { await dormir(2_000); throw new Error("Tesseract : page illisible"); });
    const [a, b] = await Promise.all([
      lireFichierUneFois({ octets: o, ext: "png", userId: UTILISATEUR }, { ocr: ko, intervalleMs: 25 }),
      lireFichierUneFois({ octets: o, ext: "png", userId: UTILISATEUR }, { ocr: ko, intervalleMs: 25 }),
    ]);
    expect(ko).toHaveBeenCalledTimes(1);
    expect(lecture(b).id).toBe(lecture(a).id);
    for (const l of [lecture(a), lecture(b)]) expect(l).toMatchObject({ etat: "ECHOUEE", ocrEchoue: true });
    // Seul celui qui a lu sait pourquoi : la base ne garde pas la raison (pas de colonne), elle ne l'invente pas.
    const lecteur = [lecture(a), lecture(b)].find((l) => l.luParCetAppel)!;
    const servi = [lecture(a), lecture(b)].find((l) => !l.luParCetAppel)!;
    expect(lecteur.raisonOcr).toContain("page illisible");
    expect(servi.raisonOcr).toBeNull();
  }, 30_000);

  it("le lecteur qui plante libère ceux qui l'attendent ; l'appel suivant retente", async () => {
    const o = octets("LECTEUR-PIEGE");
    piege.restants = 1;
    const m = moteur(TEXTE, 0);
    const [a, b] = await Promise.all([
      lireFichierUneFois({ octets: o, ext: "png", userId: UTILISATEUR }, { ocr: m, intervalleMs: 25, attenteMaxMs: 3_000 }),
      lireFichierUneFois({ octets: o, ext: "png", userId: UTILISATEUR }, { ocr: m, intervalleMs: 25, attenteMaxMs: 3_000 }),
    ]);
    const echecs = [a, b].map((r) => (r.ok ? "lu" : `${r.code}:${r.message}`)).sort();
    expect(echecs).toEqual([
      "ECHEC:La lecture de cette pièce a échoué (extraction impossible : fichier piégé) — relancez-la ; si l'échec revient, saisissez la pièce depuis le papier.",
      "ECHEC:La lecture de cette pièce a échoué pendant que vous l'attendiez — relancez-la ; si l'échec revient, saisissez la pièce depuis le papier.",
    ]);
    expect(m).not.toHaveBeenCalled();
    expect((await lignesDe(o))[0]).toMatchObject({ etat: "ECHOUEE", methode: null });

    const c = lecture(await lireFichierUneFois({ octets: o, ext: "png", userId: UTILISATEUR }, { ocr: m }));
    expect(m).toHaveBeenCalledTimes(1);
    expect(c).toMatchObject({ etat: "LUE", texte: TEXTE, luParCetAppel: true });
  }, 30_000);

  it("aucun texte en clair en base : la colonne est scellée, et `openSecret` rend le texte", async () => {
    const RIB = "RIB 007 99999 0001234567890 12";
    const texte = `FACTURE FA-2026-0142 — règlement par virement au ${RIB}. Total TTC 101 150,00.`;
    const o = octets("scelle");
    const l = lecture(await lireFichierUneFois({ octets: o, ext: "png", userId: UTILISATEUR }, { ocr: moteur(texte) }));
    // Lecture SQL BRUTE de la ligne entière : aucune colonne ne porte le texte, ni un fragment de RIB.
    const [{ j }] = await prisma.$queryRaw<{ j: string }[]>`SELECT row_to_json(l)::text AS j FROM "LecturePiece" l WHERE l.id = ${l.id}`;
    expect(j).not.toContain("0001234567890");
    expect(j).not.toContain("FACTURE FA-2026-0142");
    const [{ texteScelle }] = await prisma.$queryRaw<{ texteScelle: string | null }[]>`SELECT "texteScelle" FROM "LecturePiece" WHERE id = ${l.id}`;
    expect(openSecret(texteScelle)).toBe(texte);
  });

  it("un texte qui ne se déchiffre plus n'est pas un acquis : il se relit, sous la même ligne", async () => {
    const o = octets("indechiffrable");
    const posee = await poser(o, { etat: "LUE", methode: "ocr", caracteres: 40, texteScelle: "aGVsbG8=:Ym9ndXM=:Y2hpZmZyZQ==" });
    const m = moteur(TEXTE);
    const l = lecture(await lireFichierUneFois({ octets: o, ext: "png", userId: UTILISATEUR }, { ocr: m }));
    expect(m).toHaveBeenCalledTimes(1);
    expect(l).toMatchObject({ id: posee.id, texte: TEXTE, luParCetAppel: true });
    expect(openSecret((await prisma.lecturePiece.findUniqueOrThrow({ where: { id: posee.id } })).texteScelle)).toBe(TEXTE);
  });

  it("sans identité d'appelant, la lecture se réserve et se conclut quand même", async () => {
    const o = octets("sans-appelant");
    try {
      const l = lecture(await lireFichierUneFois({ octets: o, ext: "png" }, { ocr: moteur(TEXTE) }));
      expect(l).toMatchObject({ etat: "LUE", texte: TEXTE });
      expect((await lignesDe(o))[0]?.creeParId).toBeNull();
    } finally {
      await prisma.lecturePiece.deleteMany({ where: { empreinte: empreinteDe(o) } });
    }
  });

  it("par défaut l'OCR reste LOCAL : `cloud` n'arrive vrai au moteur que s'il est demandé, `maxPages` passe", async () => {
    const m = moteur(TEXTE);
    await lireFichierUneFois({ octets: octets("local-par-defaut"), ext: "png", maxPages: 10, userId: UTILISATEUR }, { ocr: m });
    await lireFichierUneFois({ octets: octets("cloud-demande"), ext: "png", cloud: true, userId: UTILISATEUR }, { ocr: m });
    expect(m.mock.calls.map(([x]) => [x.cloud, x.maxPages])).toEqual([[false, 10], [true, undefined]]);
  });
});
