import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { userCan, type SessionUser } from "@/lib/rbac";
import { scopeAdProOther, scopeCongressIntl, scopeCongressNational, scopeRegulatory, scopeSponsoring } from "@/lib/rbac/portees";
import { exclusionPourModele, piecesOuvrables } from "@/modules/bibliotheque/api";
import { lireRef, TYPES_NOEUD, type TypeNoeud } from "../domaine/noeuds";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CE QUE LA PERSONNE PEUT VOIR DANS LE GRAPHE (J9, décision 0021) — jugé AVANT le parcours.
 *
 * Deux étages, tous deux appelés avant qu'un nœud n'entre dans la frontière :
 *   1. LES TYPES : un type dont l'écran est fermé (module RBAC) — ou que l'appelant exclut (une famille de la console
 *      de l'Assistant IA fermée) — n'est même pas LU : ses arêtes ne sont pas interrogées ;
 *   2. LES LIGNES : chaque nœud passe la portée de l'écran qui le montre — `scopeRegulatory` + le verrou du pipeline
 *      pour un dossier, `scopeSponsoring` / `scopeCongress*` / `scopeAdProOther` pour l'Ad & Pro, `piecesOuvrables`
 *      (la règle de la route qui sert le fichier) pour un document. Les règles sont APPELÉES, jamais recopiées.
 *
 * `pourModele` : le résultat part à un modèle — une pièce confidentielle ou du coffre n'est pas un nœud (politique de la
 * Bibliothèque, `exclusionPourModele`), même pour qui peut l'ouvrir à l'écran.
 *
 * Une personne du référentiel n'est visible que si elle est un collaborateur, un professionnel de santé, un contact ou
 * un intervenant ; un candidat, un bénéficiaire ou un voyageur n'apparaît qu'à qui ouvre l'écran correspondant.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface Perimetre {
  types: ReadonlySet<TypeNoeud>;
  autoriser: (refs: string[]) => Promise<Set<string>>;
}

const voit = (u: SessionUser, ...modules: Parameters<typeof userCan>[1][]) => u.role === "SUPER_ADMIN" || modules.some((m) => userCan(u, m, "VIEW"));

/** Les types que la personne peut voir, moins ceux que l'appelant exclut. */
export function typesOuverts(user: SessionUser, exclus: readonly TypeNoeud[] = []): Set<TypeNoeud> {
  const ouverts: Record<TypeNoeud, boolean> = {
    PERSONNE: true,
    ORGANISATION: true,
    PRODUIT: true,
    DOSSIER: voit(user, "REGULATORY", "REGULATORY_PIPELINE"),
    DEMANDE_AD_PRO: voit(user, "SPONSORING", "EVENTS", "AD_PRO_OTHER"),
    CONGRES: voit(user, "CONGRESS_NATIONAL", "CONGRESS_INTERNATIONAL"),
    DOCUMENT: true,
  };
  return new Set(TYPES_NOEUD.filter((t) => ouverts[t] && !exclus.includes(t)));
}

const ROLES_PUBLICS = ["COLLABORATEUR", "PROFESSIONNEL_SANTE", "CONTACT_TIERS", "INTERVENANT"] as const;

async function personnesVisibles(user: SessionUser, ids: string[]): Promise<string[]> {
  if (user.role === "SUPER_ADMIN") return (await prisma.personne.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((p) => p.id);
  const roles: string[] = [...ROLES_PUBLICS];
  if (voit(user, "RECRUITMENT")) roles.push("CANDIDAT");
  if (voit(user, "SPONSORING", "CONGRESS_NATIONAL", "CONGRESS_INTERNATIONAL", "EVENTS")) roles.push("BENEFICIAIRE", "VOYAGEUR");
  const lignes = await prisma.personne.findMany({
    where: {
      id: { in: ids },
      OR: [
        { users: { some: {} } }, { employees: { some: {} } }, { medicalDoctors: { some: {} } },
        { roles: { some: { role: { in: roles as Prisma.EnumRolePersonneFilter["in"] } } } },
      ],
    },
    select: { id: true },
  });
  return lignes.map((p) => p.id);
}

const ids = (l: { id: string }[]) => l.map((x) => x.id);

async function evenementsVisibles(user: SessionUser, liste: string[]): Promise<string[]> {
  const m = user.access.modules.get("EVENTS");
  if (user.role !== "SUPER_ADMIN" && !m) return [];
  const where: Prisma.EventWhereInput = user.role === "SUPER_ADMIN" || m?.scope === "ALL"
    ? { id: { in: liste } }
    : { id: { in: liste }, OR: [{ requesterId: user.id }, { responsibleId: user.id }, { createdById: user.id }, { productManagerId: user.id }] };
  return ids(await prisma.event.findMany({ where, select: { id: true } }));
}

/** LE PÉRIMÈTRE d'une personne : les types ouverts et le juge des lignes. */
export function perimetreDe(user: SessionUser, o: { exclus?: readonly TypeNoeud[]; pourModele?: boolean } = {}): Perimetre {
  const types = typesOuverts(user, o.exclus);
  const autoriser = async (refs: string[]): Promise<Set<string>> => {
    const parType = new Map<TypeNoeud, string[]>();
    for (const r of refs) {
      const l = lireRef(r);
      if (!l || !types.has(l.type)) continue;
      (parType.get(l.type) ?? parType.set(l.type, []).get(l.type)!).push(l.id);
    }
    const ok = new Set<string>();
    const poser = (type: TypeNoeud, liste: string[]) => { for (const id of liste) ok.add(`${type}:${id}`); };
    const sous = (liste: string[], p: string) => liste.filter((x) => x.startsWith(p)).map((x) => x.slice(p.length));
    await Promise.all([...parType].map(async ([type, liste]) => {
      switch (type) {
        case "PERSONNE": {
          // Repli `u:` (compte sans fiche) et `e:` (salarié sans fiche) : l'annuaire des collaborateurs, ouvert à tous.
          poser(type, liste.filter((x) => x.startsWith("u:") || x.startsWith("e:")));
          poser(type, await personnesVisibles(user, liste.filter((x) => !x.includes(":"))));
          return;
        }
        case "ORGANISATION": {
          poser(type, liste.filter((x) => x.startsWith("f:") || x.startsWith("c:")));
          poser(type, ids(await prisma.organisation.findMany({ where: { id: { in: liste.filter((x) => !x.includes(":")) } }, select: { id: true } })));
          return;
        }
        case "PRODUIT":
          poser(type, ids(await prisma.product.findMany({ where: { id: { in: liste } }, select: { id: true } })));
          return;
        case "DOSSIER":
          poser(type, ids(await prisma.regulatoryProduct.findMany({ where: { AND: [{ id: { in: liste } }, scopeRegulatory(user)] }, select: { id: true } })));
          return;
        case "DEMANDE_AD_PRO": {
          const [s, a, e] = await Promise.all([
            prisma.sponsoringRequest.findMany({ where: { AND: [{ id: { in: sous(liste, "s:") } }, scopeSponsoring(user)] }, select: { id: true } }),
            prisma.adProOtherRequest.findMany({ where: { AND: [{ id: { in: sous(liste, "a:") } }, scopeAdProOther(user)] }, select: { id: true } }),
            evenementsVisibles(user, sous(liste, "e:")),
          ]);
          poser(type, [...ids(s).map((x) => `s:${x}`), ...ids(a).map((x) => `a:${x}`), ...e.map((x) => `e:${x}`)]);
          return;
        }
        case "CONGRES": {
          const [n, i] = await Promise.all([
            prisma.congressNational.findMany({ where: { AND: [{ id: { in: sous(liste, "n:") } }, scopeCongressNational(user)] }, select: { id: true } }),
            prisma.congressInternational.findMany({ where: { AND: [{ id: { in: sous(liste, "i:") } }, scopeCongressIntl(user)] }, select: { id: true } }),
          ]);
          poser(type, [...ids(n).map((x) => `n:${x}`), ...ids(i).map((x) => `i:${x}`)]);
          return;
        }
        case "DOCUMENT": {
          const ouvrables = [...(await piecesOuvrables(user, liste))];
          if (!o.pourModele) { poser(type, ouvrables); return; }
          // Pour un modèle, s'ajoute la politique de la Bibliothèque : ni pièce confidentielle, ni pièce du coffre.
          const fiches = await prisma.bibliothequeFiche.findMany({ where: { pieceId: { in: ouvrables } }, select: { pieceId: true, confidentiality: true, sensible: true } });
          poser(type, fiches.filter((f) => !exclusionPourModele(f)).map((f) => f.pieceId));
          return;
        }
      }
    }));
    return ok;
  };
  return { types, autoriser };
}
