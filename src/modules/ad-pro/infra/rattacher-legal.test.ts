import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTEUR: unknown = null;
vi.mock("@/lib/session", () => ({
  requireUser: async () => ACTEUR, requireUserAuNomDeLaVue: async () => ACTEUR,
  getUser: async () => ACTEUR,
  requireModule: async () => ACTEUR,
}));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { rattacherLegalAFiche, detacherLegalDeFiche } from "../actions-rattacher-legal";
// ⚠ ORDRE D'IMPORT IMPORTANT (documenté dans `assistant/capability-audit.test.ts`) :
// `ops/index.ts` et `lib/assistant.ts` forment un cycle d'INITIALISATION. Charger
// `assistant` d'abord — comme le fait l'application — donne l'ordre qui résout ;
// l'inverser fait échouer la SUITE ENTIÈRE sur « DOMAIN_TOOL_DEFS is not iterable ».
import "@/lib/assistant";
import { DOMAIN_TOOLS } from "@/lib/assistant/ops";
import { AD_PRO_ENTITY_TYPE, AD_PRO_KINDS } from "../domaine/unified";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__ratlegal__";
const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * BRANCHER UN DOCUMENT LEGAL EXISTANT — les DEUX droits, et rien de volé.
 *
 * Le bloc des pièces liées ne savait que CRÉER. Pour une convention déjà enregistrée dans Legal,
 * la seule issue était de la RECRÉER depuis la demande : deux lignes pour le même engagement,
 * deux montants dans les totaux, et celle qui porte les pièces jointes n'est pas celle qui porte
 * le lien.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Rattacher un document Legal existant à une fiche Ad & Pro", () => {
  let adminId = "", simpleId = "", docId = "", docAilleursId = "", sponsoId = "", autreSponsoId = "";

  beforeAll(async () => {
    const mk = (s: string, role: string) =>
      prisma.user.create({ data: { name: `${TAG}${s}`, email: `${TAG}${s}@t.dz`, role: role as never, passwordHash: "x" } });
    const [admin, simple] = await Promise.all([mk("admin", "SUPER_ADMIN"), mk("simple", "MEDICAL_DELEGATE")]);
    adminId = admin.id; simpleId = simple.id;

    const [spo, autre] = await Promise.all([
      prisma.sponsoringRequest.create({ data: { reference: `${TAG}SPO-1`, institution: `${TAG}CHU`, type: "Congrès", createdById: admin.id } }),
      prisma.sponsoringRequest.create({ data: { reference: `${TAG}SPO-2`, institution: `${TAG}Clinique`, type: "Congrès", createdById: admin.id } }),
    ]);
    sponsoId = spo.id; autreSponsoId = autre.id;

    const [libre, pris] = await Promise.all([
      prisma.legalDocument.create({ data: { title: `${TAG}Convention traiteur`, kind: "AGREEMENT", createdById: admin.id } }),
      prisma.legalDocument.create({
        data: { title: `${TAG}BC déjà rattaché`, kind: "PURCHASE_ORDER", createdById: admin.id, sourceType: "SPONSORING", sourceId: autre.id },
      }),
    ]);
    docId = libre.id; docAilleursId = pris.id;

    ACTEUR = { id: admin.id, role: "SUPER_ADMIN", secondaryRole: null, access: await getAccess(admin.id, "SUPER_ADMIN") } as unknown as SessionUser;
  });

  afterAll(async () => {
    await prisma.legalDocument.deleteMany({ where: { title: { startsWith: TAG } } }).catch(() => {});
    await prisma.sponsoringRequest.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("un document LIBRE se rattache — et RIEN n'est recréé", async () => {
    const avant = await prisma.legalDocument.count({ where: { title: { startsWith: TAG } } });
    const r = await rattacherLegalAFiche(undefined, fd({ legalId: docId, entityType: "SPONSORING", entityId: sponsoId }));
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
    const doc = await prisma.legalDocument.findUniqueOrThrow({ where: { id: docId } });
    expect(doc.sourceType).toBe("SPONSORING");
    expect(doc.sourceId).toBe(sponsoId);
    // LE POINT ENTIER DE CETTE ACTION : le document n'est pas dupliqué.
    expect(await prisma.legalDocument.count({ where: { title: { startsWith: TAG } } })).toBe(avant);
  });

  it("rattacher DEUX FOIS à la même fiche est sans effet, et le DIT", async () => {
    const r = await rattacherLegalAFiche(undefined, fd({ legalId: docId, entityType: "SPONSORING", entityId: sponsoId }));
    expect(r.ok).toBe(true);
    expect(r.ok === true ? r.message : "").toContain("déjà rattaché");
  });

  it("un document DÉJÀ rattaché ailleurs n'est PAS volé — le refus nomme le geste", async () => {
    // Déplacer sans le dire retirerait une pièce d'un dossier que quelqu'un d'autre suit, et
    // personne ne saurait où elle est passée.
    const r = await rattacherLegalAFiche(undefined, fd({ legalId: docAilleursId, entityType: "SPONSORING", entityId: sponsoId }));
    expect(r.ok).toBe(false);
    expect(r.ok === false ? r.error : "").toContain("Détachez-le");
    const doc = await prisma.legalDocument.findUniqueOrThrow({ where: { id: docAilleursId } });
    expect(doc.sourceId, "le rattachement d'origine est INTACT").toBe(autreSponsoId);
  });

  it("SANS le droit sur la fiche cible : refus — rattacher, c'est écrire sur DEUX objets", async () => {
    // Ce qui le ferait tomber : ne vérifier que le document. N'importe qui ajouterait alors des
    // engagements à la demande d'un autre.
    ACTEUR = { id: simpleId, role: "MEDICAL_DELEGATE", secondaryRole: null, access: await getAccess(simpleId, "MEDICAL_DELEGATE") } as unknown as SessionUser;
    const libre = await prisma.legalDocument.create({ data: { title: `${TAG}Autre libre`, kind: "AGREEMENT", createdById: adminId } });
    const r = await rattacherLegalAFiche(undefined, fd({ legalId: libre.id, entityType: "SPONSORING", entityId: sponsoId }));
    expect(r.ok).toBe(false);
    const apres = await prisma.legalDocument.findUniqueOrThrow({ where: { id: libre.id } });
    expect(apres.sourceId, "aucune écriture sur un refus").toBeNull();
  });

  it("une nature de fiche qui ne porte pas de pièces est refusée AVANT toute lecture", async () => {
    ACTEUR = { id: adminId, role: "SUPER_ADMIN", secondaryRole: null, access: await getAccess(adminId, "SUPER_ADMIN") } as unknown as SessionUser;
    const r = await rattacherLegalAFiche(undefined, fd({ legalId: docId, entityType: "USER", entityId: adminId }));
    expect(r.ok).toBe(false);
    expect(r.ok === false ? r.error : "").toContain("ne porte pas de pièces");
  });

  it("DÉTACHER existe — sinon le refus précédent nommerait un geste qui n'existe pas", async () => {
    // §118.63 : un refus qui renvoie vers une action absente est une impasse déguisée en
    // explication. Ce qui le ferait tomber : retirer `detacherLegalDeFiche`.
    const r = await detacherLegalDeFiche(undefined, fd({ legalId: docId }));
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
    const doc = await prisma.legalDocument.findUniqueOrThrow({ where: { id: docId } });
    expect(doc.sourceId).toBeNull();
    expect(doc.sourceType).toBeNull();
    // Détaché, il redevient rattachable — la boucle est complète.
    const encore = await rattacherLegalAFiche(undefined, fd({ legalId: docId, entityType: "SPONSORING", entityId: sponsoId }));
    expect(encore.ok).toBe(true);
  });
});

/**
 * L'ÉCRAN : le bloc « Documents » générique a DISPARU des fiches Ad & Pro, et ce qui le remplace
 * doit être là. Propriétés de STRUCTURE — elles ne se voient pas dans le rendu d'un composant
 * isolé, c'est l'écran qui les porte (§118.75, §118.49).
 */
/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE MÊME GESTE DEPUIS LA CONVERSATION — et il fallait le prouver par le VRAI registre.
 *
 * L'écran offre le rattachement dans une liste déjà filtrée ; en conversation la personne
 * NOMME la pièce et la fiche. Ce banc part de `DOMAIN_TOOLS.legal_operation`, c'est-à-dire de
 * l'objet qu'Adam reçoit — pas de l'implémentation importée à la main : vérifier le corps
 * d'une fonction sans son point d'appel ne prouve rien (§118.49), et c'est ce câblage
 * (catalogue → enum de l'outil → implémentation) qui rend l'op réellement atteignable.
 *
 * Ce que le banc EXIGE, et ce qui le ferait tomber :
 *   • la carte NOMME la pièce ET la fiche — sans l'une des deux on validerait à l'aveugle ;
 *   • `execute` ÉCRIT, vérifié en base par le lien `sourceType`/`sourceId` — une carte qui
 *     s'affiche n'est pas une écriture (§118.81) ;
 *   • un nom qui désigne DEUX fiches ne rattache RIEN et le refus nomme les candidates —
 *     collapser choisirait le dossier à la place d'un humain (§118.34) ;
 *   • une pièce libre refuse le DÉTACHEMENT au lieu de rendre un succès vide (§118.25).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Le même rattachement depuis la conversation (legal_operation)", () => {
  const TAG2 = "__ratop__";
  let adminId = "", docId = "", spoId = "", homonymeAId = "", homonymeBId = "", croiseSpoId = "", croiseEvtId = "";

  beforeAll(async () => {
    const admin = await prisma.user.create({
      data: { name: `${TAG2}admin`, email: `${TAG2}admin@t.dz`, role: "SUPER_ADMIN" as never, passwordHash: "x" },
    });
    adminId = admin.id;
    const [spo, homA, homB] = await Promise.all([
      prisma.sponsoringRequest.create({ data: { reference: `${TAG2}SPO-7`, institution: `${TAG2}CHU Oran`, type: "Congrès", createdById: admin.id } }),
      prisma.sponsoringRequest.create({ data: { reference: `${TAG2}AMBI-A`, institution: `${TAG2}Ambigu`, type: "Congrès", createdById: admin.id } }),
      prisma.sponsoringRequest.create({ data: { reference: `${TAG2}AMBI-B`, institution: `${TAG2}Ambigu`, type: "Congrès", createdById: admin.id } }),
    ]);
    spoId = spo.id; homonymeAId = homA.id; homonymeBId = homB.id;
    // AMBIGUÏTÉ CROISÉE : UNE seule fiche par nature, mais DEUX natures répondent. C'est une
    // branche DISTINCTE de l'ambiguïté interne ci-dessus (`candidats` de `resoudreCible`) —
    // ici chaque résolution rend un `retenu` d'un élément, et c'est le CUMUL qui est ambigu.
    // Sans ce cas, la branche `trouves.length > 1` n'était couverte par rien : mesuré par
    // sabotage (collapser sur le premier laissait passer 14/14).
    const [croiseSpo, croiseEvt] = await Promise.all([
      prisma.sponsoringRequest.create({ data: { reference: `${TAG2}CROISE-S`, institution: `${TAG2}Soirée Béjaïa`, type: "Congrès", createdById: admin.id } }),
      prisma.event.create({ data: { name: `${TAG2}Soirée Béjaïa`, type: "SCIENTIFIC_DAY" as never, createdById: admin.id } }),
    ]);
    croiseSpoId = croiseSpo.id; croiseEvtId = croiseEvt.id;
    const doc = await prisma.legalDocument.create({
      data: { title: `${TAG2}Convention Sanofi 2026`, kind: "AGREEMENT", createdById: admin.id },
    });
    docId = doc.id;
    ACTEUR = { id: admin.id, role: "SUPER_ADMIN", secondaryRole: null, access: await getAccess(admin.id, "SUPER_ADMIN") } as unknown as SessionUser;
  });

  afterAll(async () => {
    await prisma.legalDocument.deleteMany({ where: { title: { startsWith: TAG2 } } }).catch(() => {});
    await prisma.sponsoringRequest.deleteMany({ where: { reference: { startsWith: TAG2 } } }).catch(() => {});
    await prisma.event.deleteMany({ where: { name: { startsWith: TAG2 } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG2 } } }).catch(() => {});
  });

  // `ops[nom]` porte { meta, impl } : on passe par CE chemin, celui que le runtime emprunte.
  const op = (nom: "link_record" | "unlink_record") => {
    const entree = DOMAIN_TOOLS.legal_operation.ops[nom];
    expect(entree, `legal_operation/${nom} absente du registre de production`).toBeDefined();
    return entree.impl;
  };
  const carteDe = (fields: { label: string; value: string }[]): string =>
    fields.map((f) => `${f.label}=${f.value}`).join(" | ");
  const acteur = () => ACTEUR as Parameters<ReturnType<typeof op>["propose"]>[1];

  it("l'op EXISTE dans l'outil qu'Adam reçoit — catalogue, enum et implémentation câblés", () => {
    const schema = DOMAIN_TOOLS.legal_operation.def.input_schema as { properties: { op: { enum: string[] } } };
    expect(schema.properties.op.enum).toContain("link_record");
    expect(schema.properties.op.enum).toContain("unlink_record");
    // La description de l'outil DIT que la pièce se branche : sans ce mot, le modèle recréerait
    // l'engagement au lieu de le rattacher — ce que le code exige, le prompt doit l'offrir (§118.19).
    expect(DOMAIN_TOOLS.legal_operation.def.description).toContain("BRANCHER");
  });

  it("« rattache la Convention Sanofi à SPO-7 » : la carte NOMME les deux, puis ÉCRIT", async () => {
    const draft = await op("link_record").propose({ reference: `${TAG2}Convention Sanofi`, target: `${TAG2}SPO-7` }, acteur());
    expect("error" in draft ? draft.error : "", "la proposition a été refusée").toBe("");
    if ("error" in draft) return;
    expect(draft.title).toContain("Convention Sanofi");
    const carte = carteDe(draft.fields);
    expect(carte).toContain("Convention Sanofi");
    expect(carte).toContain(`${TAG2}SPO-7`);
    expect(draft.warnings?.join(" ")).toContain("SANS COPIE");

    const r = await op("link_record").execute(draft.args, acteur());
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    // L'ÉCRITURE, en base : une carte qui s'affiche n'est pas une écriture.
    const apres = await prisma.legalDocument.findUnique({ where: { id: docId }, select: { sourceType: true, sourceId: true } });
    expect(apres?.sourceType).toBe("SPONSORING");
    expect(apres?.sourceId).toBe(spoId);
    // Et RIEN n'a été recréé : la pièce reste unique.
    expect(await prisma.legalDocument.count({ where: { title: { startsWith: TAG2 } } })).toBe(1);
  });

  it("un nom qui désigne DEUX fiches ne rattache RIEN, et le refus les nomme", async () => {
    const draft = await op("link_record").propose({ reference: `${TAG2}Convention Sanofi`, target: `${TAG2}Ambigu` }, acteur());
    expect("error" in draft).toBe(true);
    if (!("error" in draft)) return;
    expect(draft.error).toMatch(/AMBI-A|Plusieurs|précis/i);
    // Le lien n'a pas bougé : refuser, c'est ne rien écrire.
    const apres = await prisma.legalDocument.findUnique({ where: { id: docId }, select: { sourceId: true } });
    expect(apres?.sourceId).toBe(spoId);
    expect([homonymeAId, homonymeBId].every(Boolean)).toBe(true);
  });

  it("un nom porté par DEUX NATURES ne rattache RIEN — et le refus dit de préciser la nature", async () => {
    // Un sponsoring ET un événement portent « Soirée Béjaïa » : chaque nature rend UNE cible
    // certaine, donc l'ambiguïté n'est pas dans `candidats` mais dans le CUMUL. Choisir la
    // première rattacherait la pièce à l'un des deux dossiers au hasard (§118.34).
    const draft = await op("link_record").propose({ reference: `${TAG2}Convention Sanofi`, target: `${TAG2}Soirée Béjaïa` }, acteur());
    expect("error" in draft, "l'ambiguïté CROISÉE doit être refusée").toBe(true);
    if (!("error" in draft)) return;
    expect(draft.error).toContain("2 fiches");
    expect(draft.error).toMatch(/nature/i);
    expect([croiseSpoId, croiseEvtId].every(Boolean)).toBe(true);
    // Et la pièce est restée là où elle était.
    const apres = await prisma.legalDocument.findUnique({ where: { id: docId }, select: { sourceId: true } });
    expect(apres?.sourceId).toBe(spoId);
  });

  it("une fiche hors des natures rattachables est refusée en NOMMANT l'écran qui sait", async () => {
    const draft = await op("link_record").propose({ reference: `${TAG2}Convention Sanofi`, target: "peu importe", nature: "matériel promotionnel" }, acteur());
    expect("error" in draft).toBe(true);
    if ("error" in draft) expect(draft.error).toContain("écran");
  });

  it("DÉTACHER dit DE QUOI, puis écrit — et refuse sur une pièce libre", async () => {
    const draft = await op("unlink_record").propose({ reference: `${TAG2}Convention Sanofi` }, acteur());
    expect("error" in draft ? draft.error : "").toBe("");
    if ("error" in draft) return;
    expect(carteDe(draft.fields)).toContain("sponsoring");

    const r = await op("unlink_record").execute(draft.args, acteur());
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const apres = await prisma.legalDocument.findUnique({ where: { id: docId }, select: { sourceId: true } });
    expect(apres?.sourceId).toBeNull();

    // Deuxième détachement : un succès vide serait un faux succès (§118.25).
    const encore = await op("unlink_record").propose({ reference: `${TAG2}Convention Sanofi` }, acteur());
    expect("error" in encore).toBe(true);
    if ("error" in encore) expect(encore.error).toContain("rien à détacher");
  });
});

describe("les fiches Ad & Pro n'ont plus de dépôt générique — et gardent leurs pièces", () => {
  const lire = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
  // Le code SANS ses commentaires : un commentaire qui cite `<LinkedRecords` ne monte aucun bloc,
  // et ce cliquet se serait accroché à la prose qui le décrit (§118.79d, §118.88, §118.138).
  const code = (rel: string) => lire(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  // LES SEPT FICHES, dérivées du registre canonique (§118.130) : la liste écrite à la main n'en
  // tenait que QUATRE, et le lot du 30/09/2026 a trouvé les trois autres encore sur l'ancien
  // bloc — le matériel promotionnel avec son dépôt générique, le consulting et « autre demande »
  // avec une carte « Pièces » où l'on déposait devis et factures comme de simples fichiers. Une
  // huitième nature entre ici sans que personne y pense.
  const ECRANS = AD_PRO_KINDS.map((k) => `src/app/(app)${k.href}/[id]/page.tsx`);

  it("la liste des fiches vient du registre, et chaque fiche EXISTE", () => {
    // Sans cette prémisse, un `href` renommé ferait lire un fichier absent — et le cas suivant
    // tomberait sur une exception au lieu de nommer la fiche.
    expect(ECRANS.length, "les sept natures du pôle").toBe(7);
    for (const f of ECRANS) expect(fs.existsSync(path.join(process.cwd(), f)), `${f} n'existe pas`).toBe(true);
  });

  it("plus AUCUN bloc « Documents » générique sur les fiches Ad & Pro", () => {
    // Ce qui le ferait tomber : le remettre. On y déposait à la main ce qui aurait dû être une
    // pièce du circuit, si bien que la même dépense existait deux fois — un fichier posé là et
    // un engagement dans Legal, aucun des deux ne sachant que l'autre existait.
    for (const f of [...ECRANS, "src/app/(app)/congress-international/congress-detail-view.tsx"]) {
      expect(code(f), `${f} porte encore un bloc « Documents » générique`).not.toMatch(/CardTitle[^>]*>\s*(?:<[^>]+>\s*)*(?:Documents|Pièces jointes|Pièces \()/);
    }
  });

  /**
   * DEUX FORMES DE FICHE DEPUIS LE 04/10 (§118.204). Les natures qui portent des POSTES (sponsoring,
   * prises en charge, événement) ont perdu le bloc « Pièces liées » : la chaîne d'achat vit SUR CHAQUE
   * POSTE (devis → BC → facture, `AdProItemPiece`), et la demande garde ses pièces générales dans la
   * carte des détails (« + Pièce jointe », `CarteDetailsDemande`). La demande « autre » les a rejointes le
   * 27/10/2026 (décision #17 : même circuit, mêmes postes). Les deux autres (matériel promotionnel,
   * consulting) n'ont pas de postes : elles gardent le bloc.
   *
   * La partition se LIT dans le code (qui monte le panneau des postes), et une prémisse la confronte
   * aux colonnes du modèle `AdProItem` : écrite à la main, elle ne verrait pas une fiche qui gagne ou
   * perd ses postes.
   */
  const AVEC_POSTES = () => ECRANS.filter((f) => code(f).includes("<AdProItemsPanel"));
  const SANS_POSTES = () => ECRANS.filter((f) => !code(f).includes("<AdProItemsPanel"));

  it("PRÉMISSE : les fiches à postes sont exactement les cinq parents d'un poste", () => {
    const attendues = ["/sponsoring", "/congress-international", "/congress-national", "/events", "/ad-pro/autres"].map((h) => `src/app/(app)${h}/[id]/page.tsx`).sort();
    expect(AVEC_POSTES().sort()).toEqual(attendues);
    expect(SANS_POSTES()).toHaveLength(2);
  });

  it("les fiches À POSTES n'ont plus le bloc « Pièces liées » — la demande garde ses pièces dans la carte des détails", () => {
    // Ce qui le ferait tomber : remettre `<LinkedRecords` sur une fiche à postes. Deux domiciles pour
    // un devis — la case du poste et le bloc de la demande —, et le jour où l'un est remplacé,
    // l'autre ment (§118.5). L'AUTRE MOITIÉ : sans la carte des détails, la demande du médecin —
    // obligatoire à la création — n'aurait plus aucun emplacement visible.
    for (const f of AVEC_POSTES()) {
      const src = code(f);
      expect(src, `${f} monte encore le bloc des pièces liées`).not.toContain("<LinkedRecords");
      // Sur les prises en charge (audit n° 18), la carte des détails est montée par la VUE DÉTAILLÉE : la page
      // lui passe les pièces par `piecesJointes={{ … }}`.
      // 07/10 : sur les prises en charge, la carte des détails est « La prise en charge » (`CartePriseEnCharge`), qui la monte.
      expect(src, `${f} : les pièces générales de la demande n'ont plus d'emplacement`).toMatch(/<CarteDetailsDemande|piecesJointes=\{\{|<CartePriseEnCharge[\s\S]*?pieces=\{\{/);
    }
  });

  it("les fiches SANS postes montent le bloc des pièces liées AVEC l'emplacement nommé et les droits", () => {
    for (const f of SANS_POSTES()) {
      const src = code(f);
      expect(src, `${f} : pas de bloc de pièces liées`).toContain("<LinkedRecords");
      expect(src, `${f} : les pièces de la demande n'ont pas d'emplacement nommé`).toContain("piecesDeLaDemande");
      expect(src, `${f} : les droits sur les pièces liées ne sont pas passés`).toContain("ctxPieces.acces");
      expect(src, `${f} : rien à rattacher — le bouton n'apparaîtrait jamais`).toContain("ctxPieces.candidatsLegal");
      // Les droits viennent du MÊME calcul — c'est le défaut mesuré de `ad-pro/attachments.ts` :
      // « chacun l'épelait à sa façon, et chaque orthographe oubliait quelqu'un ».
      expect(src, `${f} recalcule les droits au lieu de lire le contexte partagé`).toContain("contextePiecesLiees(user,");
    }
  });

  it("TOUT écran qui monte le bloc lui passe les droits de la personne — pas seulement le pôle", () => {
    // Sans `acces`, le bloc n'a personne à qui demander : aucun fichier n'est montré, et chaque
    // bouton de création est offert à qui gère la fiche — y compris ceux que l'action Legal
    // refuse ensuite. On cherche TOUS les points de montage (§118.58).
    const racines = ["src/app", "src/components", "src/modules"];
    const fichiers: string[] = [];
    const parcourir = (d: string) => {
      for (const e of fs.readdirSync(path.join(process.cwd(), d), { withFileTypes: true })) {
        const rel = path.join(d, e.name);
        if (e.isDirectory()) parcourir(rel);
        else if (/\.tsx$/.test(e.name)) fichiers.push(rel);
      }
    };
    racines.forEach(parcourir);
    let montages = 0;
    for (const f of fichiers) {
      if (f.endsWith("linked-records.tsx")) continue;
      const src = code(f);
      const n = (src.match(/<LinkedRecords\b/g) ?? []).length;
      if (n === 0) continue;
      montages += n;
      const avecAcces = (src.match(/\bacces=\{/g) ?? []).length;
      expect(avecAcces, `${f} monte le bloc sans les droits de la personne`).toBeGreaterThanOrEqual(n);
    }
    // Le plancher, MESURÉ au 04/10 : les trois fiches Ad & Pro sans postes et la demande du
    // secrétariat. Sans lui, un parcours cassé ne trouverait AUCUN montage et ce cas passerait au
    // vert sans rien vérifier (§118.17). 4 → 3 (refonte du bureau, 10/2026) : la fiche d'une demande au
    // secrétariat ne monte plus le bloc — ses pièces sont UNE liste (« Pièces »), lue par le même chargeur
    // (`chargerPiecesLiees`) AVEC le spectateur, donc sous la même porte pièce par pièce. 3 → 2 (27/10/2026) :
    // la demande « autre » porte des postes (décision #17) et a quitté le bloc, comme les quatre autres.
    expect(montages).toBeGreaterThanOrEqual(2);
  });

  it("le dépôt de la DEMANDE ne propose plus devis, BC, facture ni convention — ils ont leur place", () => {
    // « Devis → BC → Facture » vivent sur le poste (fiches à postes) ou au registre (les autres) : un
    // devis déposé comme simple fichier dans l'emplacement de la demande n'aurait ni fiche, ni chaîne,
    // ni validation — la double saisie qu'on ferme. Chaque téléverseur de la fiche, et chaque liste de
    // catégories passée à la carte des détails, est la liste FILTRÉE.
    for (const f of ECRANS) {
      const src = code(f);
      const televerseurs = [...src.matchAll(/<DocumentUpload\b[^>]*>/g)].map((m) => m[0]);
      const categoriesCarte = [...src.matchAll(/\bcategories:\s*([^,\n}]+)/g)].map((m) => m[1]);
      expect(televerseurs.length + categoriesCarte.length, `${f} : l'emplacement de la demande n'a aucun dépôt`).toBeGreaterThan(0);
      for (const t of televerseurs) {
        expect(t, `${f} : un téléverseur propose encore les catégories de la chaîne`).toMatch(/categories=\{categoriesDuDepotDeLaDemande\(/);
      }
      for (const c of categoriesCarte) {
        expect(c, `${f} : la carte des détails reçoit la liste brute des catégories`).toMatch(/^categoriesDuDepotDeLaDemande\(/);
      }
    }
    // La carte, elle, ne dépose qu'avec la liste qu'on lui donne — jamais une liste à elle.
    const carte = code("src/modules/ad-pro/ecrans/pieces-jointes-demande.tsx");
    expect(carte).toMatch(/<DocumentUpload\b[^>]*categories=\{pieces\.categories\}/);
  });
});

describe("Rattacher une pièce Legal — les fiches du pôle, lues dans le registre", () => {
  // Le CODE, pas la prose qui le décrit (§118.79d) : l'en-tête cite l'ancienne route fautive.
  const code = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
  it("la liste des natures qui acceptent un rattachement est EXACTEMENT celle du registre", () => {
    // `CIBLES` reste littérale (le contrat de l'action lit ses valeurs admises sous cette forme) :
    // ce cas l'empêche de diverger du registre des natures — une huitième nature devra y entrer.
    const src = code("src/modules/ad-pro/actions-rattacher-legal.ts");
    const liste = src.match(/const CIBLES: readonly EntityType\[\] = \[([^\]]*)\]/)?.[1] ?? "";
    const cibles = [...liste.matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]).sort();
    expect(cibles).toEqual(AD_PRO_KINDS.map((k) => AD_PRO_ENTITY_TYPE[k.kind]).sort());
  });

  it("l'adresse de chaque fiche vient du registre — plus aucune route écrite à la main", () => {
    const src = code("src/modules/ad-pro/actions-rattacher-legal.ts");
    expect(src).toContain("AD_PRO_KINDS.map((k) => [AD_PRO_ENTITY_TYPE[k.kind], k.href])");
    expect(src).not.toContain('"/ad-pro/materiel"');
  });
});
