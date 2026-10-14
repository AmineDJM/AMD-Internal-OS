import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
// La wilaya devinée par l'IA n'a rien à faire dans ce banc : aucune sortie réelle (§118.86).
vi.mock("@/lib/medical/wilaya-ai", () => ({ inferWilayas: async () => new Map() }));

let ACTEUR: unknown = null;
vi.mock("@/lib/session", () => ({
  requireUser: async () => ACTEUR, requireUserAuNomDeLaVue: async () => ACTEUR,
  getUser: async () => ACTEUR,
  requireModule: async () => ACTEUR,
}));

import { prisma } from "@/lib/prisma";
import { getAccess, userCan, type SessionUser } from "@/lib/rbac";
import {
  createSpecialty, updateSpecialty, deleteSpecialty, fusionnerSpecialite, rattacherLibelleSpecialite,
  createDoctor, updateDoctor,
} from "@/lib/actions/medical-actions";
import {
  saveDirectoryCell, addDirectoryDoctor, importDirectorySheet, rattacherSpecialitesParNom,
} from "@/lib/actions/medical-directory-actions";
import { chargerSpecialites } from "@/lib/queries/specialites";
import { cleDeSpecialite, ecritureDeSpecialite, indexerSpecialites, lienDeSpecialiteValide } from "@/lib/annuaires/specialites";
import { ligneAnnuaire, specialiteEstARattacher } from "@/lib/medical/directory-grid";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "ZZSPE";
const fd = (o: Record<string, string | string[]>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) {
    if (Array.isArray(v)) for (const x of v) f.append(k, x);
    else f.set(k, v);
  }
  return f;
};
const classeur = (lignes: string[][]) => {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(lignes), "Annuaire");
  const buf = XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return new File([new Uint8Array(buf)], "annuaire.xlsx");
};

describe("La spécialité d'un texte — la règle, sans base (§118.180)", () => {
  const ref = [
    { id: "c", name: "Cardiologie" },
    { id: "p1", name: "Pédiatrie" },
    { id: "p2", name: "Pediatrie" },
  ];
  const resoudre = indexerSpecialites(ref);

  it("casse, accents et espaces mis à part, un texte désigne UNE spécialité — ou aucune, ou deux", () => {
    expect(cleDeSpecialite("  CARDIOLOGIE ")).toBe(cleDeSpecialite("cardiologie"));
    expect(resoudre("cardiologie")).toEqual({ statut: "trouve", specialite: ref[0] });
    // Deux entrées du référentiel qui ne diffèrent que par un accent : un DOUBLON à fusionner, pas un choix à faire.
    expect(resoudre("pédiatrie").statut).toBe("ambigu");
    expect(resoudre("Cardio").statut).toBe("inconnu");
    expect(resoudre("  ").statut).toBe("vide");
  });

  it("ce qu'on écrit : le lien et le NOM du référentiel quand c'est sûr ; le texte tel quel sinon — jamais un lien deviné", () => {
    expect(ecritureDeSpecialite(" cardiologie ", resoudre)).toEqual({ specialtyId: "c", specialty: "Cardiologie" });
    expect(ecritureDeSpecialite("Cardio  vasculaire", resoudre)).toEqual({ specialtyId: null, specialty: "Cardio vasculaire" });
    expect(ecritureDeSpecialite("pediatrie", resoudre)).toEqual({ specialtyId: null, specialty: "pediatrie" });
    expect(ecritureDeSpecialite("", resoudre)).toEqual({ specialtyId: null, specialty: null });
  });

  it("un lien ne vaut que si le texte le désigne — un texte vide ne contredit rien", () => {
    expect(lienDeSpecialiteValide(" CARDIOLOGIE", "Cardiologie")).toBe(true);
    expect(lienDeSpecialiteValide(null, "Cardiologie")).toBe(true);
    expect(lienDeSpecialiteValide("Cardio interventionnelle", "Cardiologie")).toBe(false);
    expect(lienDeSpecialiteValide("Cardiologie", null)).toBe(false);
  });

  it("la feuille montre le nom du référentiel quand le lien vaut ; un texte qui CONTREDIT son lien l'emporte, et se dit « à rattacher »", () => {
    const base = {
      id: "d", lastName: null, firstName: null, address: null, wilaya: null, potential: "MEDIUM", postalCode: null, phone: null,
      institution: null, institutionId: null, serviceId: null, title: "DOCTEUR", email: null, sector: "LIBERAL",
    };
    // Le texte désigne le lien, à l'écriture près : c'est le NOM du référentiel qui s'affiche.
    const lie = ligneAnnuaire({ ...base, specialty: "cardiologie", specialtyId: "c", specialtyRef: { name: "Cardiologie" } });
    expect([lie.specialty, lie.specialtyId, specialiteEstARattacher(lie)]).toEqual(["Cardiologie", "c", false]);
    const sansTexte = ligneAnnuaire({ ...base, specialty: null, specialtyId: "c", specialtyRef: { name: "Cardiologie" } });
    expect([sansTexte.specialty, sansTexte.specialtyId]).toEqual(["Cardiologie", "c"]);
    // UN TEXTE QUI CONTREDIT SON LIEN est une saisie plus récente — l'ancien import remplaçait le
    // texte sans toucher au lien. Afficher le lien la défairait en silence (le cas de §118.172).
    const contredit = ligneAnnuaire({ ...base, specialty: "Cardio interventionnelle", specialtyId: "c", specialtyRef: { name: "Cardiologie" } });
    expect([contredit.specialty, contredit.specialtyId, specialiteEstARattacher(contredit)]).toEqual(["Cardio interventionnelle", null, true]);
    const texte = ligneAnnuaire({ ...base, specialty: "Cardio", specialtyId: null, specialtyRef: null });
    expect([texte.specialty, texte.specialtyId, specialiteEstARattacher(texte)]).toEqual(["Cardio", null, true]);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE RÉFÉRENTIEL DES SPÉCIALITÉS ET LES LIENS DES PRATICIENS, PAR LES VRAIS POINTS D'ENTRÉE.
 *
 * Les acteurs n'ont PAS de vue globale là où la portée est le fait testé (§118.104) : un délégué
 * (Promotion médicale en « ses lignes », créer et modifier, pas supprimer) et la Direction (tout).
 * Les noms du référentiel portent le préfixe du banc : la base est partagée, et `indexerSpecialites`
 * lit tout le référentiel — un « Cardiologie » d'un banc voisin rendrait ce banc ambigu.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Le référentiel des spécialités et la feuille de l'annuaire (§118.180)", () => {
  let delegue = "", direction = "", lecteur = "";
  let cardio = "", pneumo = "";
  let fMoi = "", fAutre = "", fLie = "", fContredit = "";

  const acteur = async (id: string, role: string) =>
    ({ id, role, secondaryRole: null, name: `${TAG}${role}`, access: await getAccess(id, role as never) } as unknown as SessionUser);
  const C = `${TAG}Cardiologie`;
  const P = `${TAG}Pneumologie`;

  const nettoyer = async () => {
    const comptes = await prisma.user.findMany({ where: { email: { startsWith: TAG.toLowerCase() } }, select: { id: true } }).catch(() => []);
    await prisma.medicalDoctor.deleteMany({ where: { OR: [{ name: { contains: TAG } }, { lastName: { contains: TAG } }] } }).catch(() => {});
    // SANS la casse : un sabotage qui laisse passer le doublon « zzspe… » laisserait une spécialité en
    // minuscules que `startsWith` ne voit pas — et chaque run suivant tomberait sur ce résidu, pour une
    // raison qui n'est pas la sienne (§118.117).
    await prisma.medicalSpecialty.deleteMany({ where: { name: { startsWith: TAG, mode: "insensitive" } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: comptes.map((c) => c.id) } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG.toLowerCase() } } }).catch(() => {});
  };

  beforeAll(async () => {
    await nettoyer();
    const mk = (s: string, role: string) =>
      prisma.user.create({ data: { name: `${TAG}${s}`, email: `${TAG.toLowerCase()}${s}@t.dz`, role: role as never, passwordHash: "x" } });
    const [d, dir, l] = await Promise.all([mk("delegue", "MEDICAL_DELEGATE"), mk("direction", "DIRECTION"), mk("lecteur", "VIEWER")]);
    delegue = d.id; direction = dir.id; lecteur = l.id;
    const [c, p] = await Promise.all([
      prisma.medicalSpecialty.create({ data: { name: C, color: "#ff0000", notes: `${TAG}notes` } }),
      prisma.medicalSpecialty.create({ data: { name: P } }),
    ]);
    cardio = c.id; pneumo = p.id;
    const doc = (name: string, extra: Record<string, unknown>) =>
      prisma.medicalDoctor.create({ data: { name: `${TAG}${name}`, lastName: `${TAG}${name}`, ...extra }, select: { id: true } });
    const [a, b, e, k] = await Promise.all([
      // Deux fiches « Cardio » écrites à la main : une au délégué, une à personne.
      doc("Moi", { delegateId: delegue, specialty: `${TAG}Cardio` }),
      doc("Autre", { specialty: `  ${TAG.toLowerCase()}cardio ` }),
      // Une fiche déjà rattachée : son texte dit son lien.
      doc("Lié", { delegateId: delegue, specialtyId: cardio, specialty: C }),
      // UN TEXTE PLUS RÉCENT QUE SON LIEN — ce que l'ancien import laissait : il remplaçait le texte
      // sans toucher au lien. C'est la saisie qui fait foi, et cette fiche est « à rattacher ».
      doc("Contredit", { delegateId: delegue, specialtyId: cardio, specialty: `${TAG}Cardio interventionnelle` }),
    ]);
    fMoi = a.id; fAutre = b.id; fLie = e.id; fContredit = k.id;
  });

  afterAll(nettoyer);

  it("les acteurs sont ce que le banc croit qu'ils sont", async () => {
    const d = await acteur(delegue, "MEDICAL_DELEGATE");
    expect(d.access.modules.get("MEDICAL")?.scope).not.toBe("ALL");
    expect(userCan(d, "MEDICAL", "UPDATE")).toBe(true);
    expect(userCan(d, "MEDICAL", "DELETE")).toBe(false);
    expect(userCan(await acteur(lecteur, "VIEWER"), "MEDICAL", "CREATE")).toBe(false);
  });

  describe("le référentiel", () => {
    it("ajouter : audité sous SON type ; un doublon à l'écriture près est refusé en nommant le titulaire", async () => {
      ACTEUR = await acteur(direction, "DIRECTION");
      const r = await createSpecialty(fd({ name: `${TAG}Néphrologie` }));
      expect(r.ok, r.ok ? "" : r.error).toBe(true);
      expect(await prisma.auditLog.count({ where: { entityType: "SPECIALTY", entityId: r.id } })).toBe(1);
      const doublon = await createSpecialty(fd({ name: `  ${TAG.toLowerCase()}nephrologie ` }));
      expect(doublon).toEqual({ ok: false, error: `« ${TAG.toLowerCase()}nephrologie » existe déjà dans le référentiel (« ${TAG}Néphrologie »).` });
      ACTEUR = await acteur(lecteur, "VIEWER");
      expect((await createSpecialty(fd({ name: `${TAG}Autre` }))).ok).toBe(false);
    });

    it("renommer : le libellé des fiches suit ; la couleur et les notes que le formulaire ne porte pas restent ; un nom pris est refusé", async () => {
      ACTEUR = await acteur(direction, "DIRECTION");
      const r = await updateSpecialty(fd({ id: cardio, name: `${TAG}Cardiologie interventionnelle` }));
      expect(r.ok, r.ok ? "" : r.error).toBe(true);
      const s = await prisma.medicalSpecialty.findUniqueOrThrow({ where: { id: cardio } });
      expect([s.name, s.color, s.notes]).toEqual([`${TAG}Cardiologie interventionnelle`, "#ff0000", `${TAG}notes`]);
      expect((await prisma.medicalDoctor.findUniqueOrThrow({ where: { id: fLie } })).specialty).toBe(`${TAG}Cardiologie interventionnelle`);
      // LE TEXTE QUI CONTREDISAIT LE LIEN n'est pas réécrit : c'était la saisie la plus récente, et un
      // renommage du référentiel ne décide pas à sa place.
      expect((await prisma.medicalDoctor.findUniqueOrThrow({ where: { id: fContredit } })).specialty).toBe(`${TAG}Cardio interventionnelle`);
      const pris = await updateSpecialty(fd({ id: cardio, name: P }));
      expect(pris.ok).toBe(false);
      expect(pris.ok ? "" : pris.error).toContain("fusionnez");
      await updateSpecialty(fd({ id: cardio, name: C }));
    });
  });

  describe("la feuille : le texte devient un lien quand c'est sûr, et reste un texte sinon", () => {
    it("la cellule : « cardiologie » se rattache et prend le NOM du référentiel ; un texte inconnu reste écrit sans lien ; vide efface les deux", async () => {
      ACTEUR = await acteur(direction, "DIRECTION");
      const lie = await saveDirectoryCell({ id: fMoi, field: "specialty", value: ` ${TAG.toLowerCase()}cardiologie` });
      expect(lie.ok, lie.ok ? "" : lie.error).toBe(true);
      let f = await prisma.medicalDoctor.findUniqueOrThrow({ where: { id: fMoi } });
      expect([f.specialtyId, f.specialty]).toEqual([cardio, C]);
      await saveDirectoryCell({ id: fMoi, field: "specialty", value: `${TAG}Cardio` });
      f = await prisma.medicalDoctor.findUniqueOrThrow({ where: { id: fMoi } });
      // L'ANCIENNE CELLULE effaçait le lien en écrivant le texte, MÊME quand le texte désignait le
      // référentiel : c'est ce cas, pas celui-ci, que la ligne précédente éprouve.
      expect([f.specialtyId, f.specialty]).toEqual([null, `${TAG}Cardio`]);
      const vide = await saveDirectoryCell({ id: fAutre, field: "specialty", value: "" });
      expect(vide.ok).toBe(true);
      f = await prisma.medicalDoctor.findUniqueOrThrow({ where: { id: fAutre } });
      expect([f.specialtyId, f.specialty]).toEqual([null, null]);
      await prisma.medicalDoctor.update({ where: { id: fAutre }, data: { specialty: `  ${TAG.toLowerCase()}cardio ` } });
    });

    it("l'ajout d'une ligne rattache la spécialité saisie quand elle désigne le référentiel", async () => {
      ACTEUR = await acteur(direction, "DIRECTION");
      const r = await addDirectoryDoctor({ lastName: `${TAG}Ajout`, firstName: "", specialty: P.toUpperCase(), wilaya: "Alger" });
      expect(r.ok, r.ok ? "" : r.error).toBe(true);
      const f = await prisma.medicalDoctor.findUniqueOrThrow({ where: { id: r.id } });
      expect([f.specialtyId, f.specialty]).toEqual([pneumo, P]);
    });

    it("l'import : la spécialité reconnue se rattache ; l'inconnue reste écrite, et le bilan la NOMME", async () => {
      ACTEUR = await acteur(direction, "DIRECTION");
      const r = await importDirectorySheet(fd({
        file: classeur([["Nom complet", "Spécialité"], [`${TAG}Import Un`, P.toLowerCase()], [`${TAG}Import Deux`, `${TAG}Rhumato`]]) as unknown as string,
      }));
      expect(r.ok, r.ok ? "" : r.error).toBe(true);
      const un = await prisma.medicalDoctor.findFirstOrThrow({ where: { name: `${TAG}Import Un` } });
      const deux = await prisma.medicalDoctor.findFirstOrThrow({ where: { name: `${TAG}Import Deux` } });
      expect([un.specialtyId, un.specialty]).toEqual([pneumo, P]);
      expect([deux.specialtyId, deux.specialty]).toEqual([null, `${TAG}Rhumato`]);
      expect(r.message).toContain(`« ${TAG}Rhumato »`);
      expect(r.message).toContain("Annuaires › Spécialités");
    });

    it("la fiche du praticien : le texte tapé se résout ; l'identifiant l'emporte ; un identifiant inconnu est refusé ; un formulaire qui ne la porte pas la GARDE", async () => {
      ACTEUR = await acteur(direction, "DIRECTION");
      const c = await createDoctor(undefined, fd({ name: `${TAG}Fiche créée`, specialty: ` ${P.toLowerCase()}` }));
      expect(c.ok, c.ok ? "" : c.error).toBe(true);
      const id = c.ok ? (c.id ?? "") : "";
      let f = await prisma.medicalDoctor.findUniqueOrThrow({ where: { id } });
      expect([f.specialtyId, f.specialty]).toEqual([pneumo, P]);
      const refus = await updateDoctor(fd({ id, specialtyId: `${TAG}inexistant` }));
      expect(refus.ok).toBe(false);
      // Un formulaire qui ne porte pas la spécialité (l'op d'Adam, un appel partiel) la garde (§118.152c).
      expect((await updateDoctor(fd({ id, phone: "0550000000" }))).ok).toBe(true);
      f = await prisma.medicalDoctor.findUniqueOrThrow({ where: { id } });
      expect([f.specialtyId, f.specialty]).toEqual([pneumo, P]);
      // Choisie dans la liste, c'est le référentiel qui parle — le texte voisin ne la contredit pas.
      expect((await updateDoctor(fd({ id, specialtyId: cardio, specialty: `${TAG}n'importe quoi` }))).ok).toBe(true);
      f = await prisma.medicalDoctor.findUniqueOrThrow({ where: { id } });
      expect([f.specialtyId, f.specialty]).toEqual([cardio, C]);
    });

    it("le rattachement en lot : seulement à coup sûr — un doublon du référentiel n'est pas départagé, il est DIT", async () => {
      ACTEUR = await acteur(direction, "DIRECTION");
      // Un doublon que `createSpecialty` refuserait : posé directement, comme un héritage d'avant la règle.
      const [d1, d2] = await Promise.all([
        prisma.medicalSpecialty.create({ data: { name: `${TAG}Gériatrie` } }),
        prisma.medicalSpecialty.create({ data: { name: `${TAG}Geriatrie` } }),
      ]);
      const [sure, double, contredit] = await Promise.all([
        prisma.medicalDoctor.create({ data: { name: `${TAG}Lot sûr`, specialty: P.toLowerCase() }, select: { id: true } }),
        prisma.medicalDoctor.create({ data: { name: `${TAG}Lot double`, specialty: `${TAG}geriatrie` }, select: { id: true } }),
        // Un lien que son texte contredit : la feuille le montre « à rattacher », le lot le reprend —
        // et c'est le TEXTE, la saisie la plus récente, qui se résout.
        prisma.medicalDoctor.create({ data: { name: `${TAG}Lot contredit`, specialtyId: cardio, specialty: P.toLowerCase() }, select: { id: true } }),
      ]);
      const r = await rattacherSpecialitesParNom({ ids: [sure.id, double.id, contredit.id] });
      expect(r.ok, r.ok ? "" : r.error).toBe(true);
      expect((await prisma.medicalDoctor.findUniqueOrThrow({ where: { id: sure.id } })).specialtyId).toBe(pneumo);
      expect((await prisma.medicalDoctor.findUniqueOrThrow({ where: { id: double.id } })).specialtyId).toBeNull();
      const repris = await prisma.medicalDoctor.findUniqueOrThrow({ where: { id: contredit.id } });
      expect([repris.specialtyId, repris.specialty]).toEqual([pneumo, P]);
      expect(r.message).toContain("fusionnez-les");
      // HORS DE LA PORTÉE : un délégué ne rattache pas la fiche d'un praticien hors de son panel,
      // même quand elle est dans la liste qu'il envoie — le refus le DIT, la fiche ne bouge pas.
      const horsPanel = await prisma.medicalDoctor.create({ data: { name: `${TAG}Lot hors panel`, specialty: P.toLowerCase() }, select: { id: true } });
      ACTEUR = await acteur(delegue, "MEDICAL_DELEGATE");
      const r2 = await rattacherSpecialitesParNom({ ids: [horsPanel.id] });
      expect(r2.ok, r2.ok ? "" : r2.error).toBe(true);
      expect((await prisma.medicalDoctor.findUniqueOrThrow({ where: { id: horsPanel.id } })).specialtyId).toBeNull();
      expect(r2.message).toContain("hors de votre portée");
      ACTEUR = await acteur(direction, "DIRECTION");
      await prisma.medicalDoctor.deleteMany({ where: { id: { in: [sure.id, double.id, contredit.id, horsPanel.id] } } });
      await prisma.medicalSpecialty.deleteMany({ where: { id: { in: [d1.id, d2.id] } } });
    });
  });

  describe("les libellés hérités : l'écran les compte dans la portée, et une personne décide de ce qu'ils désignent", () => {
    it("le chargeur regroupe « Cardio » et « cardio » sous un libellé, et ne compte que ce que la personne voit", async () => {
      const toutVoir = await chargerSpecialites(await acteur(direction, "DIRECTION"));
      const h = toutVoir.heritees.find((x) => cleDeSpecialite(x.libelle) === cleDeSpecialite(`${TAG}cardio`));
      expect(h?.praticiens).toBe(2);
      expect(h?.variantes.length).toBe(1);
      const sienne = await chargerSpecialites(await acteur(delegue, "MEDICAL_DELEGATE"));
      expect(sienne.heritees.find((x) => cleDeSpecialite(x.libelle) === cleDeSpecialite(`${TAG}cardio`))?.praticiens).toBe(1);
      // Le compte des RATTACHÉS aussi : la fiche liée du délégué, pas celles des autres — et pas celle
      // dont le texte contredit le lien, qui se compte sous SON texte, comme la feuille la montre.
      expect(sienne.specialites.find((s) => s.id === cardio)?.praticiens).toBe(1);
      expect(sienne.heritees.find((x) => x.libelle === `${TAG}Cardio interventionnelle`)?.praticiens).toBe(1);
    });

    it("rattacher un libellé : un délégué ne relabellise que ses fiches ; la Direction, toutes", async () => {
      // LA MÊME ÉCRITURE, HORS DU PANEL : c'est le cas que la portée de l'écriture existe pour attraper.
      // Une écriture différente (« zzspecardio ») ne l'exerçait pas — elle n'est même pas parmi celles que
      // le délégué voit — et le sabotage qui retirait la portée passait au vert (§118.111).
      const meme = await prisma.medicalDoctor.create({ data: { name: `${TAG}Même écriture, hors panel`, specialty: `${TAG}Cardio` }, select: { id: true } });
      ACTEUR = await acteur(delegue, "MEDICAL_DELEGATE");
      const r = await rattacherLibelleSpecialite(fd({ libelle: `${TAG}Cardio`, specialtyId: cardio }));
      expect(r.ok, r.ok ? "" : r.error).toBe(true);
      expect(r.rattachees).toBe(1);
      expect((await prisma.medicalDoctor.findUniqueOrThrow({ where: { id: fMoi } })).specialtyId).toBe(cardio);
      expect((await prisma.medicalDoctor.findUniqueOrThrow({ where: { id: fAutre } })).specialtyId).toBeNull();
      expect((await prisma.medicalDoctor.findUniqueOrThrow({ where: { id: meme.id } })).specialtyId).toBeNull();
      ACTEUR = await acteur(direction, "DIRECTION");
      const r2 = await rattacherLibelleSpecialite(fd({ libelle: `${TAG}Cardio`, specialtyId: cardio }));
      expect(r2.rattachees).toBe(2);
      const autre = await prisma.medicalDoctor.findUniqueOrThrow({ where: { id: fAutre } });
      expect([autre.specialtyId, autre.specialty]).toEqual([cardio, C]);
      // UN LIEN QUE LE TEXTE CONTREDIT se reprend comme un texte sans lien : la personne décide de ce
      // que ce libellé désigne, et le lien périmé ne l'en empêche pas.
      const r3 = await rattacherLibelleSpecialite(fd({ libelle: `${TAG}Cardio interventionnelle`, specialtyId: pneumo }));
      expect(r3.rattachees).toBe(1);
      const contredit = await prisma.medicalDoctor.findUniqueOrThrow({ where: { id: fContredit } });
      expect([contredit.specialtyId, contredit.specialty]).toEqual([pneumo, P]);
      // UN LIEN QUI VAUT N'EST JAMAIS DÉPLACÉ par ce geste : « Cardiologie », écrit sur une fiche liée à
      // la spécialité qui porte ce nom, n'est pas un libellé hérité — même si quelqu'un choisit, à tort,
      // de le rattacher ailleurs.
      const r4 = await rattacherLibelleSpecialite(fd({ libelle: C, specialtyId: pneumo }));
      expect(r4.rattachees).toBe(0);
      expect((await prisma.medicalDoctor.findUniqueOrThrow({ where: { id: fLie } })).specialtyId).toBe(cardio);
    });
  });

  describe("fusionner, retirer — sans jamais détruire la donnée d'un praticien", () => {
    it("fusionner déplace les fiches (lien ET libellé) puis retire la source ; le délégué ne fusionne pas", async () => {
      ACTEUR = await acteur(direction, "DIRECTION");
      const doublon = await prisma.medicalSpecialty.create({ data: { name: `${TAG}Cardiologie bis` } });
      const [fiche, contredite] = await Promise.all([
        prisma.medicalDoctor.create({ data: { name: `${TAG}Fusion`, specialtyId: doublon.id, specialty: `${TAG}Cardiologie bis` }, select: { id: true } }),
        prisma.medicalDoctor.create({ data: { name: `${TAG}Fusion contredite`, specialtyId: doublon.id, specialty: `${TAG}Autre chose` }, select: { id: true } }),
      ]);
      ACTEUR = await acteur(delegue, "MEDICAL_DELEGATE");
      expect((await fusionnerSpecialite(fd({ id: doublon.id, cibleId: cardio }))).ok).toBe(false);
      ACTEUR = await acteur(direction, "DIRECTION");
      expect((await fusionnerSpecialite(fd({ id: cardio, cibleId: cardio }))).ok).toBe(false);
      const r = await fusionnerSpecialite(fd({ id: doublon.id, cibleId: cardio }));
      expect(r.ok, r.ok ? "" : r.error).toBe(true);
      const f = await prisma.medicalDoctor.findUniqueOrThrow({ where: { id: fiche.id } });
      expect([f.specialtyId, f.specialty]).toEqual([cardio, C]);
      // LA FICHE DONT LE TEXTE CONTREDISAIT LE LIEN ne passe pas à la cible : elle garde son texte et
      // perd le lien périmé — la rattacher poserait un second lien que son texte contredit.
      const c = await prisma.medicalDoctor.findUniqueOrThrow({ where: { id: contredite.id } });
      expect([c.specialtyId, c.specialty]).toEqual([null, `${TAG}Autre chose`]);
      expect(r.message).toContain("contredisait");
      expect(await prisma.medicalSpecialty.findUnique({ where: { id: doublon.id } })).toBeNull();
    });

    it("retirer une spécialité du référentiel : ses fiches GARDENT le libellé, sans lien — l'ancienne écriture l'effaçait", async () => {
      ACTEUR = await acteur(direction, "DIRECTION");
      // Un lien que son texte contredit : retirer la spécialité ne remplace pas ce texte par le nom
      // retiré — l'écriture d'avant ce banc l'aurait fait, en effaçant la saisie la plus récente.
      const contredite = await prisma.medicalDoctor.create({ data: { name: `${TAG}Retrait contredit`, specialtyId: pneumo, specialty: `${TAG}Pneumo pédiatrique` }, select: { id: true } });
      const r = await deleteSpecialty(fd({ id: pneumo }));
      expect(r.ok, r.ok ? "" : r.error).toBe(true);
      const ajout = await prisma.medicalDoctor.findFirstOrThrow({ where: { lastName: `${TAG}Ajout` } });
      expect([ajout.specialtyId, ajout.specialty]).toEqual([null, P]);
      const garde = await prisma.medicalDoctor.findUniqueOrThrow({ where: { id: contredite.id } });
      expect([garde.specialtyId, garde.specialty]).toEqual([null, `${TAG}Pneumo pédiatrique`]);
      expect(r.message).toContain("à rattacher");
      expect(await prisma.auditLog.count({ where: { entityType: "SPECIALTY", entityId: pneumo, action: "DELETE" } })).toBe(1);
    });
  });
});
