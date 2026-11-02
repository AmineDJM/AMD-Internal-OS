/**
 * REGULATORY — le DOSSIER lu par les actions : la DCI normalisée et ses doublons (ceux qu'on nomme, ceux qu'on compte),
 * ce qui existe déjà de la molécule, la supervision.
 *
 * Sorti de `actions/regulatory-actions.ts` (lot V4) : lectures et règles, aucune écriture.
 */
import type { ProductChannel } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isRegulatorySupervisor, type SessionUser } from "@/lib/rbac";
import type { requireUser } from "@/lib/session";
import { getAppSettings } from "@/lib/settings";
import { regulatoryVisibleWhere } from "@/lib/queries/regulatory-rows";
import { dciKey, duplicateNotice, needsAccessRequest, type DciDuplicate } from "@/lib/regulatory/dci-duplicate";

/** Canal produit (Ville / Hôpital / les deux). undefined si absent → laisse la valeur en place. */
export function parseProductChannel(v: string | null): ProductChannel | undefined {
  return v === "RETAIL" || v === "HOSPITAL" || v === "BOTH" ? v : undefined;
}

/** Uniformise la casse des DCI : MAJUSCULES, espaces normalisés autour des « + ». */
export function normalizeDci(value: string): string {
  return value.trim().toUpperCase().replace(/\s*\+\s*/g, " + ").replace(/\s+/g, " ");
}
export const upperMolecules = (list: string[]): string[] => list.map((m) => m.trim().toUpperCase()).filter(Boolean);

/** L'utilisateur courant est-il superviseur Regulatory (fixe priorité/dates, demande des MàJ) ? */
export async function ensureRegSupervisor(user: Awaited<ReturnType<typeof requireUser>>): Promise<boolean> {
  const settings = await getAppSettings();
  return isRegulatorySupervisor(user, settings.regulatorySupervisorRoles);
}

/**
 * LES DOSSIERS QUI PORTENT DÉJÀ CETTE DCI — ceux qu'on peut nommer, et ceux qu'on compte.
 *
 * Deux lectures, et la différence entre elles EST le renseignement :
 *
 *   • sans portée, pour SAVOIR qu'un homonyme existe. Aucun nom n'en sort — seulement des
 *     identifiants qui servent à filtrer la seconde requête, puis un décompte ;
 *   • avec `regulatoryVisibleWhere`, la clause UNIQUE que l'écran Regulatory applique déjà
 *     (verrou du pipeline, portée par ligne, cloisonnement par entité, gamme), pour savoir
 *     lesquels cette personne a le droit de VOIR — ceux-là seulement seront nommés.
 *
 * Reprendre la clause de l'écran plutôt que d'en réécrire une ici n'est pas de l'élégance : une
 * seconde clause dériverait au premier droit ajouté, et c'est ce jour-là qu'un avertissement
 * nommerait un dossier confidentiel.
 *
 * La comparaison se fait en mémoire parce qu'elle ne s'exprime PAS en SQL : « A + B » et
 * « B + A » sont la même association, et un `equals` les manquerait — précisément le doublon
 * qu'on cherche.
 */
export async function dciDuplicatesFor(user: SessionUser, dci: string): Promise<DciDuplicate> {
  const cle = dciKey(dci);
  if (!cle) return { visible: [], hidden: 0 };

  const tous = await prisma.regulatoryProduct.findMany({ select: { id: true, dci: true } });
  const ids = tous.filter((p) => dciKey(p.dci) === cle).map((p) => p.id);
  if (ids.length === 0) return { visible: [], hidden: 0 };

  const visible = await prisma.regulatoryProduct.findMany({
    where: { AND: [await regulatoryVisibleWhere(user), { id: { in: ids } }] },
    select: { id: true, reference: true, brandName: true, dosage: true, pharmaceuticalForm: true },
    orderBy: { reference: "asc" },
  });
  return { visible, hidden: ids.length - visible.length };
}

/** Ce qui existe déjà de la molécule (même forme qu'`ExistantDeLaMolecule`, exportée par le fichier d'actions). */
interface Existant {
  nature: "DOSSIER" | "PRODUIT";
  id: string;
  libelle: string;
  detail: string;
  identite?: { dosage: string | null; dosageUnit: string | null; form: string | null; packaging: string | null; brandName: string | null };
}

/**
 * CE QUI EXISTE DÉJÀ DE LA MOLÉCULE, proposé pendant la saisie : l'avis de doublon, s'il y a un dossier caché à
 * demander, les dossiers VISIBLES et les produits du référentiel qui la portent.
 */
export async function existantsDeLaMolecule(
  user: SessionUser, propre: string,
): Promise<{ notice: string | null; canRequestAccess: boolean; existants: Existant[] }> {
  const doublons = await dciDuplicatesFor(user, propre);
  // CE QUI EXISTE DÉJÀ, PROPOSÉ (Direction, 06/10) : les dossiers VISIBLES de cette molécule (on les ouvre), et les
  // produits du référentiel canonique qui la portent (on part de l'un d'eux, ou l'on crée un nouveau produit).
  const cle = dciKey(propre);
  const produits = (await prisma.product.findMany({
    where: { isActive: true, dci: { contains: propre.split(" + ")[0], mode: "insensitive" } },
    select: { id: true, code: true, canonicalName: true, dci: true, dosage: true, dosageUnit: true, form: true, packaging: true },
    take: 40,
  })).filter((p) => dciKey(p.dci) === cle);
  const existants: Existant[] = [
    ...doublons.visible.map((d) => ({
      nature: "DOSSIER" as const, id: d.id, libelle: `${d.reference}${d.brandName ? ` — ${d.brandName}` : ""}`,
      detail: [d.dosage, d.pharmaceuticalForm].filter(Boolean).join(" · ") || "dossier existant",
    })),
    ...produits.map((p) => ({
      nature: "PRODUIT" as const, id: p.id, libelle: p.canonicalName, detail: [p.code, p.dosage ? `${p.dosage} ${p.dosageUnit ?? ""}`.trim() : null, p.form, p.packaging].filter(Boolean).join(" · "),
      identite: { dosage: p.dosage, dosageUnit: p.dosageUnit, form: p.form, packaging: p.packaging, brandName: null },
    })),
  ];
  const notice = duplicateNotice(propre, doublons) ?? (produits.length ? `« ${propre} » existe déjà dans le référentiel produits (${produits.length} produit${produits.length > 1 ? "s" : ""}).` : null);
  return { notice, canRequestAccess: needsAccessRequest(doublons), existants };
}
