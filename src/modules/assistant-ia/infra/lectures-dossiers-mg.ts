import { prisma } from "@/lib/prisma";
import type { PowerTool } from "@/platform/ia/outil";
import type { CurrentUser } from "@/lib/session";
import { scopeDossiers, userCan } from "@/lib/rbac";
import { resultatVide } from "@/platform/ia/lectures/empty-result";
import { LIBELLE_PRIORITE_DOSSIER, LIBELLE_STATUT_DOSSIER, lireStatutDossier, replierTexte, type PrioriteDossier, type StatutDossier } from "@/modules/suivi-dossiers/partage";
import { libelleInstant, lireCreneau } from "@/modules/salles/partage";
import { conflitsDeReservation } from "@/modules/salles/api";
import { lectureCaisseAvance } from "./caisse-avance";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LIRE LE SUIVI DE DOSSIERS ET LES MOYENS GÉNÉRAUX (lot T3) — des réponses PRÉCISES, calculées ici.
 *
 *   • `lire_dossiers_suivi` — les dossiers que la personne voit (`scopeDossiers`) : en retard (échéance passée, non
 *     abouti), à relancer (sans mouvement depuis N jours), par statut, responsable, catégorie, mot ; les COMPTES par
 *     statut et par responsable sont faits par le code (le modèle ne compte pas) ;
 *   • `lire_caisse_avance` — la caisse d'avance (« moyens généraux » chez Adventum, Direction 02/11/2026), `./caisse-avance.ts` ;
 *   • `lire_salles` — les salles de réunion, leurs réservations et les salles libres d'un créneau (tous les employés).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const texte = (e: Record<string, unknown>, k: string): string => (typeof e[k] === "string" ? (e[k] as string).trim() : "");
const nombre = (e: Record<string, unknown>, k: string, defaut: number, max: number): number => {
  const n = typeof e[k] === "number" ? (e[k] as number) : Number(e[k]);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), max) : defaut;
};
const ymd = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const OUVERTS: StatutDossier[] = ["OPEN", "IN_PROGRESS", "ON_HOLD"];

export const OUTIL_DOSSIERS_SUIVI = "lire_dossiers_suivi";
export const OUTIL_SALLES = "lire_salles";

export function lecturesDossiersEtMoyens(user: CurrentUser): PowerTool[] {
  return [
    lectureCaisseAvance(user),
    {
      def: {
        name: OUTIL_DOSSIERS_SUIVI,
        description: "Lit le SUIVI DE DOSSIERS (sujets DOS-AAAA-NNN) que je vois, avec des COMPTES exacts : `filtre` = en_retard (échéance passée, non abouti), "
          + "a_relancer (ouvert sans mouvement depuis `jours`, 7 par défaut), tous ; plus `statut` (ouvert, en cours, en attente, abouti, archivé), `responsable` (nom ou « moi »), "
          + "`categorie`, `q` (mot de l'intitulé ou référence). Rend les dossiers (référence, intitulé, statut, responsable, échéance, retard en jours, dernier mouvement) et les totaux par statut et par responsable.",
        input_schema: {
          type: "object",
          properties: {
            filtre: { type: "string", enum: ["tous", "en_retard", "a_relancer"] },
            statut: { type: "string" }, responsable: { type: "string" }, categorie: { type: "string" }, q: { type: "string" },
            jours: { type: "number", description: "Seuil « sans mouvement » pour a_relancer (jours)." },
            limite: { type: "number", description: "Au plus N dossiers listés (30 par défaut)." },
          },
        },
      } as PowerTool["def"],
      label: "Suivi de dossiers consulté",
      allowed: (u) => u.id === user.id && userCan(u, "DOSSIERS", "VIEW"),
      run: async (e, u) => {
        const maintenant = new Date();
        const filtre = texte(e, "filtre") || "tous";
        const jours = nombre(e, "jours", 7, 365);
        const statutVoulu = texte(e, "statut") ? lireStatutDossier(texte(e, "statut")) : null;
        if (texte(e, "statut") && !statutVoulu) return JSON.stringify({ statut: "REFUS", raison: `Statut « ${texte(e, "statut")} » inconnu : ouvert, en cours, en attente, abouti ou archivé.` });
        const where: Record<string, unknown>[] = [scopeDossiers(u)];
        if (statutVoulu) where.push({ status: statutVoulu });
        else where.push({ status: { not: "ARCHIVED" } });
        if (filtre === "en_retard") where.push({ dueDate: { lt: maintenant }, status: { in: OUVERTS } });
        if (filtre === "a_relancer") where.push({ status: { in: OUVERTS }, updatedAt: { lt: new Date(maintenant.getTime() - jours * 86_400_000) } });
        if (texte(e, "categorie")) where.push({ category: { contains: texte(e, "categorie"), mode: "insensitive" } });
        const q = texte(e, "q");
        if (q) where.push({ OR: [{ title: { contains: q, mode: "insensitive" } }, { reference: { contains: q, mode: "insensitive" } }] });
        const resp = texte(e, "responsable");
        if (resp) {
          if (/^(moi|moi-meme|moi meme)$/i.test(resp)) where.push({ assignedToId: u.id });
          else {
            const mots = replierTexte(resp).split(/\s+/).filter(Boolean);
            const us = await prisma.user.findMany({ where: { AND: mots.map((m) => ({ name: { contains: m, mode: "insensitive" as const } })) }, select: { id: true }, take: 10 });
            where.push({ assignedToId: { in: us.map((x) => x.id) } });
          }
        }
        const tous = await prisma.dossier.findMany({
          where: { AND: where }, orderBy: [{ dueDate: "asc" }, { updatedAt: "asc" }], take: 1_000,
          select: {
            id: true, reference: true, title: true, status: true, priority: true, category: true, dueDate: true, updatedAt: true, assignedTo: { select: { name: true } },
          },
        });
        // Le dernier message du fil compte comme un mouvement (agrégé en une requête, jamais un `take` imbriqué).
        const derniersMessages = new Map((await prisma.dossierMessage.groupBy({ by: ["dossierId"], where: { dossierId: { in: tous.map((d) => d.id) } }, _max: { createdAt: true } }))
          .map((g) => [g.dossierId, g._max.createdAt]));
        if (!tous.length) return resultatVide("Aucun dossier ne correspond, parmi ceux que vous voyez.");
        const parStatut: Record<string, number> = {};
        const parResponsable: Record<string, number> = {};
        for (const d of tous) {
          parStatut[LIBELLE_STATUT_DOSSIER[d.status as StatutDossier]] = (parStatut[LIBELLE_STATUT_DOSSIER[d.status as StatutDossier]] ?? 0) + 1;
          const r = d.assignedTo?.name ?? "Sans responsable";
          parResponsable[r] = (parResponsable[r] ?? 0) + 1;
        }
        const limite = nombre(e, "limite", 30, 200);
        return JSON.stringify({
          total: tous.length, filtre, ...(filtre === "a_relancer" ? { sans_mouvement_depuis_jours: jours } : {}), par_statut: parStatut, par_responsable: parResponsable,
          dossiers: tous.slice(0, limite).map((d) => {
            const msg = derniersMessages.get(d.id);
            const dernier = msg && msg > d.updatedAt ? msg : d.updatedAt;
            const retard = d.dueDate && OUVERTS.includes(d.status as StatutDossier) && d.dueDate < maintenant ? Math.floor((maintenant.getTime() - d.dueDate.getTime()) / 86_400_000) : 0;
            return {
              reference: d.reference, intitule: d.title, statut: LIBELLE_STATUT_DOSSIER[d.status as StatutDossier], priorite: LIBELLE_PRIORITE_DOSSIER[d.priority as PrioriteDossier],
              categorie: d.category, responsable: d.assignedTo?.name ?? null, echeance: ymd(d.dueDate), ...(retard ? { retard_jours: retard } : {}),
              dernier_mouvement: ymd(dernier), sans_mouvement_jours: Math.floor((maintenant.getTime() - dernier.getTime()) / 86_400_000),
            };
          }),
          ...(tous.length > limite ? { note: `${tous.length - limite} autre(s) non listé(s) — les totaux portent sur les ${tous.length}.` } : {}),
        });
      },
    },
    {
      def: {
        name: OUTIL_SALLES,
        description: "Lit les SALLES DE RÉUNION et leurs réservations (ouvert à tous les employés) : chaque salle et sa capacité, les réservations entre `du` et `au` (AAAA-MM-JJ, 7 jours par défaut), "
          + "et, avec `debut`/`fin` (AAAA-MM-JJTHH:MM), les salles LIBRES sur ce créneau.",
        input_schema: {
          type: "object",
          properties: { du: { type: "string" }, au: { type: "string" }, debut: { type: "string" }, fin: { type: "string" }, participants: { type: "number" } },
        },
      } as PowerTool["def"],
      label: "Salles consultées",
      allowed: (u) => u.id === user.id,
      run: async (e) => {
        const maintenant = new Date();
        const salles = await prisma.moyenGeneral.findMany({ where: { statut: "ACTIF", type: "SALLE" }, orderBy: [{ capacite: "asc" }, { libelle: "asc" }], select: { id: true, libelle: true, capacite: true } });
        if (!salles.length) return resultatVide("Aucune salle de réunion n'est déclarée.");
        const jour = (s: string, defaut: Date) => (/^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00+01:00`) : defaut);
        const du = jour(texte(e, "du"), new Date(maintenant.getTime() - 3_600_000));
        const au = new Date(jour(texte(e, "au"), new Date(du.getTime() + 7 * 86_400_000)).getTime() + (texte(e, "au") ? 86_400_000 : 0));
        const rs = await prisma.moyenGeneralReservation.findMany({
          where: { statut: "CONFIRMEE", moyenId: { in: salles.map((x) => x.id) }, debut: { lt: au }, fin: { gt: du } }, orderBy: { debut: "asc" }, take: 200,
          select: { moyenId: true, debut: true, fin: true, objet: true, participants: true, reserveParId: true },
        });
        const noms = new Map((await prisma.user.findMany({ where: { id: { in: [...new Set(rs.map((r) => r.reserveParId))] } }, select: { id: true, name: true } })).map((x) => [x.id, x.name]));
        const nomSalle = new Map(salles.map((x) => [x.id, x.libelle]));
        const creneau = texte(e, "debut") ? lireCreneau(texte(e, "debut"), texte(e, "fin") || null) : null;
        const participants = typeof e.participants === "number" ? e.participants : null;
        const libres = creneau ? [] as string[] : null;
        if (creneau && libres) for (const x of salles) if ((!participants || !x.capacite || x.capacite >= participants) && !(await conflitsDeReservation(x.id, creneau)).length) libres.push(`${x.libelle}${x.capacite ? ` (${x.capacite} places)` : ""}`);
        return JSON.stringify({
          salles: salles.map((x) => ({ salle: x.libelle, capacite: x.capacite })),
          reservations: rs.map((r) => ({ salle: nomSalle.get(r.moyenId), debut: libelleInstant(r.debut), fin: libelleInstant(r.fin), objet: r.objet, participants: r.participants, reserve_par: noms.get(r.reserveParId) ?? null })),
          ...(creneau ? { creneau: `${libelleInstant(creneau.debut)} → ${libelleInstant(creneau.fin)}`, salles_libres: libres } : {}),
        });
      },
    },
  ];
}
