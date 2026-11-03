import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import { fichierVisible } from "../operations/pieces";
import { sansBloquer } from "@/lib/journal";
import { blocObserve, observer, type Observation } from "../../domaine/observation/contrat";
import { etatDIntention, projeterEffet } from "../../domaine/observation/projecteurs";
import { mesMissions, observationDeMission } from "../missions/pilotage";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA RE-PROJECTION (lot I1, décision 0063 ; audit AU1 §4.4) — les observations d'un tour passé, RELUES en base au tour
 * suivant : le statut est celui d'aujourd'hui (la carte proposée hier est-elle confirmée, annulée, partie ?). Une erreur
 * signalée par la personne trouve alors l'état réel, sans détecter la contestation : il est toujours là, à jour.
 *
 * Une requête par nature (les identifiants sont connus) ; tout sous la portée de la personne (`userId`, `principalId`,
 * droits du Drive). Un objet introuvable le DIT (jamais l'ancien état présenté comme actuel).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const STATUT_MAIL: Readonly<Record<string, string>> = {
  DRAFT: "BROUILLON", AWAITING_APPROVAL: "PROPOSEE", APPROVED: "PROGRAMME", SENDING: "PROGRAMME", SENT: "PARTI", FAILED: "ECHEC", CANCELLED: "ANNULEE", EXPIRED: "EXPIREE",
};

const heure = (d: Date | null | undefined) => (d ? d.toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Algiers" }) : null);

interface Relecture { relues: Observation[]; effets: Map<string, Observation[]> }

async function relire(user: CurrentUser, obs: readonly Observation[], maintenant: Date): Promise<Relecture> {
  if (!obs.length) return { relues: [], effets: new Map() };
  const ids = (type: string) => [...new Set(obs.filter((o) => o.objet.type === type).map((o) => o.objet.id))];
  const idsCartes = ids("intention"), idsMissions = ids("mission"), idsFichiers = ids("fichier_drive");
  const [cartes, missions, fichiers] = await Promise.all([
    idsCartes.length
      ? prisma.assistantActionIntent.findMany({ where: { id: { in: idsCartes }, userId: user.id }, select: { id: true, status: true, title: true, resultMessage: true, resultLink: true, error: true, executedAt: true, payload: true } })
      : Promise.resolve([]),
    idsMissions.length ? mesMissions(user.id, { toutes: true, maintenant }).then((r) => r.missions) : Promise.resolve([]),
    idsFichiers.length ? prisma.driveNode.findMany({ where: { id: { in: idsFichiers } }, select: { id: true, name: true, isTrashed: true } }) : Promise.resolve([]),
  ]);
  // Les effets sortants d'une carte d'envoi (Gmail d'Adam) : chaque intention d'envoi, relue.
  const sortants = cartes.flatMap((c) => {
    const brut = (c.payload as { args?: { outboundIds?: string } } | null)?.args?.outboundIds;
    try { return brut ? (JSON.parse(brut) as unknown[]).map(String).map((id) => ({ carte: c.id, id })) : []; } catch { return []; }
  });
  const mails = sortants.length
    ? await prisma.outboundMailIntent.findMany({ where: { id: { in: sortants.map((s) => s.id) } }, select: { id: true, status: true, recipients: true, subject: true, sentAt: true } })
    : [];
  const visibles = new Set<string>();
  for (const f of fichiers) {
    if (!f.isTrashed && (await fichierVisible(user, f.id).catch(sansBloquer("observation.reprojeter.drive", false)))) visibles.add(f.id);
  }
  const parCarte = new Map(cartes.map((c) => [c.id, c]));
  const parMission = new Map(missions.map((m) => [m.id, m]));
  const parFichier = new Map(fichiers.map((f) => [f.id, f]));
  const effets = new Map<string, Observation[]>();
  const relues = obs.map((o): Observation => {
    if (o.objet.type === "intention") {
      const c = parCarte.get(o.objet.id);
      if (!c) return observer(o.nature, o.objet, "RETIREE", o.projection, maintenant);
      for (const s of sortants.filter((x) => x.carte === c.id)) {
        const m = mails.find((x) => x.id === s.id);
        if (m) effets.set(c.id, [...(effets.get(c.id) ?? []), projeterEffet({ id: m.id, type: "mail_adam", canal: "Gmail d'Adam", etat: STATUT_MAIL[m.status] ?? m.status, a: m.recipients, objet: m.subject, depart: m.status === "SENT" ? heure(m.sentAt) : null }, maintenant)]);
      }
      return observer(o.nature, { ...o.objet, lien: c.resultLink ?? o.objet.lien }, etatDIntention(c.status), {
        ...o.projection, titre: c.title, resultat: c.resultMessage ?? c.error ?? undefined,
      }, maintenant);
    }
    if (o.objet.type === "mission") {
      const m = parMission.get(o.objet.id);
      return m ? observationDeMission(m, maintenant) : observer(o.nature, o.objet, "INTROUVABLE", { titre: o.projection.titre ?? null }, maintenant);
    }
    if (o.objet.type === "fichier_drive") {
      const f = parFichier.get(o.objet.id);
      return f && visibles.has(f.id)
        ? observer(o.nature, o.objet, "ECRIT", { ...o.projection, nom: f.name }, maintenant)
        : observer(o.nature, { ...o.objet, lien: null }, "INTROUVABLE", { nom: o.projection.nom ?? null }, maintenant);
    }
    // Une lecture est un fait daté : elle reste ce qu'elle était (son `observeLe` le dit).
    return o;
  });
  return { relues, effets };
}

/**
 * LE BLOC « OBSERVÉ » de chaque réponse passée, en une passe : toutes les observations relues ensemble (une requête par
 * nature pour tout l'historique), puis rendues réponse par réponse — chaque carte suivie de ses effets sortants.
 */
export async function blocsObserves(user: CurrentUser, parReponse: readonly (readonly Observation[])[], maintenant: Date = new Date()): Promise<(string | null)[]> {
  const toutes = parReponse.flat();
  if (!toutes.length) return parReponse.map(() => null);
  const r = await relire(user, toutes, maintenant).catch(sansBloquer("observation.blocsObserves", null));
  if (!r) return parReponse.map((l) => blocObserve(l));
  let i = 0;
  return parReponse.map((liste) => {
    const miennes = r.relues.slice(i, i + liste.length);
    i += liste.length;
    return blocObserve(miennes.flatMap((o) => [o, ...(o.objet.type === "intention" ? r.effets.get(o.objet.id) ?? [] : [])]));
  });
}
