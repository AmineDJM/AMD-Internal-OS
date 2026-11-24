import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { deleteFileByKey } from "@/lib/storage";
import { releaseBlob } from "@/lib/drive-storage";
import { libererVersionsDocuments } from "@/lib/document-versions";
import { sansBloquer } from "@/lib/journal";
import { ENTITE_DU_MODELE, LIENS_DIRECTS, REFERENTS, delegueDe, nomDe } from "./branches";
import { RELATIONS, cleDeLigne, identiteDe, inventorier, ouIdentite, type Inventaire } from "./lot";
import { ATTACHES_TEXTE, PARTAGEABLES, PROPRIETAIRES_NEUTRES, RETOURS_DEFINITIFS, SUITES_DEFINITIVES } from "./definitive";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA DESTRUCTION D'UNE DEMANDE AD & PRO ET DE TOUT CE QUI LUI EST LIÉ — et seulement cela
 * (Super Admin, 24/11/2026). Le pendant DÉFINITIF du lot de la corbeille (`lot.ts`) : même
 * inventaire, lu dans le schéma, élargi des suites et des retours de `definitive.ts` ; aucune
 * entrée de corbeille, aucune restauration.
 *
 * Ce fichier n'est PAS `"use server"` : il prend un modèle et un identifiant sans savoir qui appelle.
 * Sa seule porte est `supprimerDefinitivementDemandeAdPro` (module ad-pro), qui exige le Super Admin
 * réel — le cliquet `definitive.test.ts` vérifie que personne d'autre ne l'importe.
 *
 * Trois temps :
 *   1. LE PÉRIMÈTRE (`perimetreDefinitif`) — l'inventaire, puis les PARTAGEABLES reliés aussi à
 *      autre chose sont retirés du lot (et l'inventaire relu sans eux, jusqu'à ce qu'il ne bouge plus) ;
 *   2. LA DESTRUCTION (`detruireDefinitivement`) — UNE transaction : liens du dehors vidés, attaches
 *      des pièces gardées vidées, pièces jointes, lignes (enfants d'abord), notifications, et la trace ;
 *   3. LES FICHIERS (`libererLesFichiers`) — APRÈS la transaction, par les fonctions de libération
 *      existantes : une clé qu'une ligne restante cite encore n'est pas effacée, un blob compte ses détenteurs.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

type Delegue = {
  findMany: (a: unknown) => Promise<Record<string, unknown>[]>;
  deleteMany: (a: unknown) => Promise<{ count: number }>;
  updateMany: (a: unknown) => Promise<{ count: number }>;
};
type Client = Prisma.TransactionClient | typeof prisma;
const d = (c: Client, modele: string) => (c as unknown as Record<string, Delegue>)[delegueDe(modele)];

/** Le modèle qui porte un type d'entité — l'inverse de `ENTITE_DU_MODELE`. */
const MODELE_DE_L_ENTITE = new Map(Object.entries(ENTITE_DU_MODELE).map(([m, e]) => [String(e), m]));

/** Les tours de relecture au plus : une pièce gardée peut en rendre une autre « partagée » (un BC et sa facture). */
const MAX_TOURS = 6;

export interface PieceGardee { modele: string; id: string; libelle: string; pourquoi: string }

export interface Perimetre {
  inv: Inventaire;
  /** Les partageables reliés aussi à autre chose : ils RESTENT, seul leur lien à la demande part. */
  gardees: PieceGardee[];
  /** Les attaches à vider sur ces pièces gardées (leur couple source vers une ligne qui part). */
  detacher: { modele: string; id: string; champType: string; champId: string; type: string; valeur: string }[];
}

const OPTIONS = (exclus: ReadonlySet<string>) => ({
  suites: SUITES_DEFINITIVES, retours: RETOURS_DEFINITIFS, exclus, faitsBloquent: false, recreer: false,
});

/** TOUT ce qui part — et ce qui reste parce qu'il sert aussi autre chose. Rien n'est écrit. */
export async function perimetreDefinitif(modeleTete: string, idTete: string): Promise<Perimetre | null> {
  const exclus = new Set<string>();
  const gardees: PieceGardee[] = [];
  let inv: Inventaire | null = null;
  for (let tour = 0; tour < MAX_TOURS; tour++) {
    inv = await inventorier(modeleTete, idTete, OPTIONS(exclus));
    if (!inv) return null;
    const partages = (await partagesDuLot(inv)).filter((p) => !exclus.has(cleDeLigne(p.modele, p.id)));
    if (partages.length === 0) break;
    for (const p of partages) { exclus.add(cleDeLigne(p.modele, p.id)); gardees.push(p); }
    if (tour === MAX_TOURS - 1) inv = await inventorier(modeleTete, idTete, OPTIONS(exclus));
  }
  if (!inv) return null;
  return { inv, gardees, detacher: await attachesAVider(inv, gardees) };
}

/**
 * UN PARTAGEABLE DU LOT EST-IL RELIÉ À AUTRE CHOSE ? Quatre façons de l'être, et chacune est un cas réel :
 *   • son propre couple source désigne une ligne qui RESTE (la pièce née d'un autre dossier) ;
 *   • une ligne qui reste le désigne par une clé étrangère (la facture d'un autre achat chaînée à ce BC) ;
 *   • une de SES lignes rattachées appartient aussi à une ligne qui reste (le même BC rattaché au poste
 *     d'une autre demande : la ligne de rattachement a deux propriétaires en cascade) ;
 *   • un champ texte d'une ligne qui reste le cite (la demande de pièce d'un autre poste, son ordre de règlement).
 */
async function partagesDuLot(inv: Inventaire): Promise<PieceGardee[]> {
  const dans = new Set(inv.lignes.map((l) => cleDeLigne(l.modele, l.id)));
  const parCle = new Map(inv.lignes.map((l) => [cleDeLigne(l.modele, l.id), l]));
  const out: PieceGardee[] = [];
  const garder = (l: { modele: string; id: string; donnees: Record<string, unknown> }, pourquoi: string) => {
    if (out.some((o) => o.modele === l.modele && o.id === l.id)) return;
    const libelle = String(l.donnees.reference ?? l.donnees.title ?? l.donnees.name ?? l.id);
    out.push({ modele: l.modele, id: l.id, libelle, pourquoi });
  };
  const estDans = (modele: string | undefined, id: unknown) => !!modele && typeof id === "string" && dans.has(cleDeLigne(modele, id));

  for (const x of inv.lignes.slice(1)) {
    if (!PARTAGEABLES[x.modele]) continue;
    // 1. Son couple source.
    for (const ref of REFERENTS) {
      if (ref.modele !== x.modele) continue;
      const t = x.donnees[ref.champType];
      const v = x.donnees[ref.champId];
      if (typeof t === "string" && typeof v === "string" && v && !estDans(MODELE_DE_L_ENTITE.get(t), v)) {
        garder(x, `rattachée à un autre élément (${t.toLowerCase()})`);
      }
    }
    // 2 et 3. Les clés étrangères qui le désignent.
    for (const r of RELATIONS) {
      if (r.parent !== x.modele) continue;
      const rows = await d(prisma, r.enfant).findMany({ where: { [r.champ]: x.id } });
      for (const row of rows) {
        const k = cleDeLigne(r.enfant, identiteDe(r.enfant, row));
        if (!dans.has(k)) { garder(x, `citée hors de la demande (${nomDe(r.enfant)})`); continue; }
        if (r.action !== "Cascade") continue;
        const enfant = parCle.get(k)?.donnees ?? row;
        for (const autre of RELATIONS) {
          if (autre.enfant !== r.enfant || autre.champ === r.champ || autre.action !== "Cascade" || PROPRIETAIRES_NEUTRES.has(autre.parent)) continue;
          const v = enfant[autre.champ];
          if (typeof v === "string" && v && !estDans(autre.parent, v)) garder(x, `servant aussi un autre élément (${nomDe(autre.parent)})`);
        }
      }
    }
    // 3 bis. Un lien « relié à » (deux couples) dont l'autre bout reste.
    for (const l of inv.lignes) {
      const couples = REFERENTS.filter((ref) => ref.modele === l.modele && ref.conduite === "EMPORTEE");
      if (couples.length < 2) continue;
      const bouts = couples.map((ref) => ({ t: l.donnees[ref.champType], v: l.donnees[ref.champId] }));
      const versX = bouts.some((b) => b.v === x.id && MODELE_DE_L_ENTITE.get(String(b.t)) === x.modele);
      if (versX && bouts.some((b) => typeof b.v === "string" && !estDans(MODELE_DE_L_ENTITE.get(String(b.t)), b.v))) {
        garder(x, "reliée à un autre élément");
      }
    }
  }
  // 4. Les champs texte qui citent un partageable, depuis une ligne qui reste : les attaches connues, et tout lien
  // direct ou suite (non clé étrangère — celles-là sont lues au 2) dont la cible est un partageable.
  const estCle = (modele: string, champ: string) => RELATIONS.some((r) => r.enfant === modele && r.champ === champ);
  const attaches = [...ATTACHES_TEXTE, ...LIENS_DIRECTS, ...SUITES_DEFINITIVES]
    .filter((a) => PARTAGEABLES[a.cible] && !estCle(a.modele, a.champ));
  for (const a of attaches) {
    const cibles = inv.lignes.filter((l) => l.modele === a.cible).map((l) => l.id);
    if (cibles.length === 0) continue;
    for (const row of await d(prisma, a.modele).findMany({ where: { [a.champ]: { in: cibles } } })) {
      if (dans.has(cleDeLigne(a.modele, identiteDe(a.modele, row)))) continue;
      const x = parCle.get(cleDeLigne(a.cible, String(row[a.champ])));
      if (x) garder(x, `citée hors de la demande (${nomDe(a.modele)})`);
    }
  }
  return out;
}

/** Le couple source d'une pièce GARDÉE qui désigne une ligne qui part : on le vide (seul le lien part). */
async function attachesAVider(inv: Inventaire, gardees: readonly PieceGardee[]): Promise<Perimetre["detacher"]> {
  const dans = new Set(inv.lignes.map((l) => cleDeLigne(l.modele, l.id)));
  const out: Perimetre["detacher"] = [];
  for (const g of gardees) {
    for (const ref of REFERENTS) {
      if (ref.modele !== g.modele) continue;
      const [row] = await d(prisma, g.modele).findMany({ where: { id: g.id }, take: 1 } as never);
      const t = row?.[ref.champType];
      const v = row?.[ref.champId];
      const m = typeof t === "string" ? MODELE_DE_L_ENTITE.get(t) : undefined;
      if (typeof v === "string" && m && dans.has(cleDeLigne(m, v))) {
        out.push({ modele: g.modele, id: g.id, champType: ref.champType, champId: ref.champId, type: String(t), valeur: v });
      }
    }
  }
  return out;
}

/** Les modèles qui ont une adresse à l'écran : une notification qui les cite pointe vers la demande. */
const ADRESSES = new Set([
  "SponsoringRequest", "CongressNational", "CongressInternational", "Event", "AdProOtherRequest", "PromoMaterial",
  "AdProItem", "ExpenseOrder", "PaymentRequest", "LegalDocument", "ValidationRequest", "AdministrativeRequest",
  "MedicalInfoDeclaration", "Dossier", "DocumentRequest", "CarePecBc", "Task",
]);

/**
 * DÉTRUIT le périmètre — tout ou rien. L'appelant a vérifié le droit, la référence retapée, et l'absence de
 * bloquant ; `trace` écrit la ligne d'audit DANS la transaction : pas de destruction sans sa trace.
 */
export async function detruireDefinitivement(
  p: Perimetre,
  trace: (tx: Prisma.TransactionClient) => Promise<void>,
): Promise<void> {
  const { inv } = p;
  if (inv.bloquants.length > 0) throw new Error("[destruction] périmètre bloqué — l'appelant devait refuser");
  const enfantsDabord = [...inv.lignes].reverse();
  const idsDocs = inv.documents.map((x) => String(x.id));
  const idsComs = inv.commentaires.map((x) => String(x.id));
  const motifs = inv.lignes.filter((l) => ADRESSES.has(l.modele)).map((l) => `%${l.id}%`);
  await prisma.$transaction(async (tx) => {
    // Les liens TEXTE du dehors (une facture d'un autre dossier qui citait l'ordre) : seule la valeur encore là est vidée.
    for (const lien of inv.liensExternes) {
      if (lien.doux) await d(tx, lien.modele).updateMany({ where: { ...lien.cle, [lien.champ]: lien.valeur }, data: { [lien.champ]: null } });
    }
    // Les pièces GARDÉES perdent leur attache à la demande — elles restent pour ce qu'elles servent d'autre.
    for (const a of p.detacher) {
      await d(tx, a.modele).updateMany({ where: { id: a.id, [a.champType]: a.type, [a.champId]: a.valeur }, data: { [a.champType]: null, [a.champId]: null } });
    }
    if (idsDocs.length) await tx.document.deleteMany({ where: { id: { in: idsDocs } } });
    if (idsComs.length) await tx.comment.deleteMany({ where: { id: { in: idsComs } } });
    // deleteMany : une ligne déjà partie en cascade compte 0. `ouIdentite` refuse une clé manquante — jamais « tout ».
    for (const l of enfantsDabord) await d(tx, l.modele).deleteMany({ where: ouIdentite(l.modele, l.donnees) });
    // Les notifications qui pointent vers la demande ou l'une de ses branches : UN passage sur la table.
    if (motifs.length) await tx.$executeRaw`DELETE FROM "Notification" WHERE "link" LIKE ANY(${motifs}::text[])`;
    await trace(tx);
  }, { timeout: 120_000, maxWait: 10_000 });
}

/** Les champs qui tiennent un fichier — lus dans le schéma, pas recopiés : un modèle neuf y entre seul. */
const MODELES = Prisma.dmmf.datamodel.models;
const CHAMPS_CLE = MODELES.flatMap((m) => m.fields
  .filter((f) => f.kind === "scalar" && f.type === "String" && /fileKey$/i.test(f.name))
  .map((f) => ({ modele: m.name, champ: f.name })));
const CHAMPS_BLOB = (modele: string) => (MODELES.find((m) => m.name === modele)?.fields ?? [])
  .filter((f) => f.kind === "scalar" && f.type === "String" && /blobId$/i.test(f.name)).map((f) => f.name);

export interface Fichiers { cles: string[]; blobs: string[]; documents: string[] }

/** Les fichiers que tenaient les lignes détruites — lus AVANT la destruction (les lignes ne seront plus là). */
export function fichiersDuPerimetre(p: Perimetre): Fichiers {
  const cles = new Set<string>();
  const blobs: string[] = [];
  const lignes = [...p.inv.lignes, ...p.inv.documents.map((x) => ({ modele: "Document", id: String(x.id), donnees: x }))];
  for (const l of lignes) {
    for (const c of CHAMPS_CLE) {
      const v = c.modele === l.modele ? l.donnees[c.champ] : undefined;
      if (typeof v === "string" && v) cles.add(v);
    }
    for (const c of CHAMPS_BLOB(l.modele)) {
      const v = l.donnees[c];
      if (typeof v === "string" && v) blobs.push(v);
    }
  }
  return { cles: [...cles], blobs, documents: p.inv.documents.map((x) => String(x.id)) };
}

/**
 * LIBÈRE les fichiers des lignes détruites — après la transaction, jamais avant : une destruction annulée ne doit
 * rien avoir effacé. Une clé encore citée par une ligne qui reste (le même fichier déposé ailleurs) est GARDÉE ;
 * un blob rend la référence de chaque ligne qui le tenait, `releaseBlob` n'efface que ce que plus personne ne tient.
 */
export async function libererLesFichiers(f: Fichiers): Promise<void> {
  await libererVersionsDocuments(f.documents).catch(sansBloquer("suppression-definitive.libererVersionsDocuments"));
  const encoreCitees = new Set<string>();
  if (f.cles.length) {
    for (const c of CHAMPS_CLE) {
      const rows = await d(prisma, c.modele).findMany({ where: { [c.champ]: { in: f.cles } }, select: { [c.champ]: true } }).catch(() => []);
      for (const r of rows) encoreCitees.add(String(r[c.champ]));
    }
  }
  for (const k of f.cles) {
    if (!encoreCitees.has(k)) await deleteFileByKey(k).catch(sansBloquer("suppression-definitive.deleteFileByKey"));
  }
  for (const b of f.blobs) await releaseBlob(b).catch(sansBloquer("suppression-definitive.releaseBlob"));
}
