import { prisma } from "@/lib/prisma";
import { notifyRoles } from "@/lib/notify";
import { journal, releverCompteurs, restituerCompteurs, sansBloquer, SEUIL_INCIDENT, type CompteurIncident } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES ERREURS RÉPÉTÉES REMONTENT AU SUPER ADMIN (lot V3-E « Fiabilité »).
 *
 * Le journal unique (`@/lib/journal`) COMPTE chaque erreur, en mémoire du processus. Ici, deux
 * gestes, appelés par les tâches de fond :
 *
 *  1. `verserCompteurs()` — à CHAQUE passage, dans CHAQUE processus (web et worker : chacun a sa
 *     mémoire). Les compteurs rejoignent la table `IncidentRepete` par un UPSERT atomique qui
 *     additionne dans la fenêtre courante, ou la rouvre si elle est échue. Base injoignable : le
 *     lot est restitué au processus et repartira au passage suivant.
 *  2. `alerterIncidentsRepetes()` — une tâche planifiée (un seul exécutant, par bail). Les
 *     événements qui ont dépassé `SEUIL` erreurs dans leur fenêtre et n'ont pas été signalés
 *     depuis `RAPPEL_MS` partent en UNE notification agrégée. Pas de spam : un événement qui
 *     échoue en continu sonne une fois toutes les six heures, pas à chaque minute.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Une erreur isolée n'alerte personne ; cinq dans l'heure, si (le même seuil que la sonde). */
export const SEUIL = SEUIL_INCIDENT;
export const FENETRE_MS = 60 * 60_000;
/** Un même événement ne resonne pas avant six heures. */
export const RAPPEL_MS = 6 * 60 * 60_000;
/** Au-delà, la notification renvoie au Diagnostic plutôt que de tout énumérer. */
const MAX_LISTES = 8;

/** Verse les compteurs de CE processus en base. Ne lève jamais. Rend le nombre d'événements versés. */
export async function verserCompteurs(): Promise<number> {
  const lot = releverCompteurs();
  if (lot.length === 0) return 0;
  try {
    for (const c of lot) await verserUn(c);
    return lot.length;
  } catch (e) {
    restituerCompteurs(lot);
    // Volontairement HORS comptage (avertissement) : sinon une base en panne s'alimenterait elle-même.
    journal.avertissement("incidents.versement-differe", { evenements: lot.length }, e);
    return 0;
  }
}

function verserUn(c: CompteurIncident): Promise<number> {
  const dernier = new Date(c.dernierA);
  const premier = new Date(c.premierA);
  const message = c.dernierMessage || null;
  const fenetreSecondes = Math.round(FENETRE_MS / 1000);
  // Une seule instruction : deux processus qui versent ensemble additionnent, ils ne s'écrasent pas.
  return prisma.$executeRaw`
    INSERT INTO "IncidentRepete" ("evenement", "total", "fenetreDebut", "compteFenetre", "premierA", "dernierA", "dernierMessage", "updatedAt")
    VALUES (${c.evenement}, ${c.compte}, ${premier}, ${c.compte}, ${premier}, ${dernier}, ${message}, NOW())
    ON CONFLICT ("evenement") DO UPDATE SET
      "total" = "IncidentRepete"."total" + EXCLUDED."total",
      "compteFenetre" = CASE
        WHEN "IncidentRepete"."fenetreDebut" < NOW() - make_interval(secs => ${fenetreSecondes}) THEN EXCLUDED."compteFenetre"
        ELSE "IncidentRepete"."compteFenetre" + EXCLUDED."compteFenetre" END,
      "fenetreDebut" = CASE
        WHEN "IncidentRepete"."fenetreDebut" < NOW() - make_interval(secs => ${fenetreSecondes}) THEN EXCLUDED."fenetreDebut"
        ELSE "IncidentRepete"."fenetreDebut" END,
      "dernierA" = GREATEST("IncidentRepete"."dernierA", EXCLUDED."dernierA"),
      "dernierMessage" = COALESCE(EXCLUDED."dernierMessage", "IncidentRepete"."dernierMessage"),
      "updatedAt" = NOW()`;
}

export type IncidentAAlerter = { evenement: string; compteFenetre: number; dernierMessage: string | null };

/** Pur : qui mérite une alerte maintenant. */
export function incidentsAAlerter(
  lignes: readonly { evenement: string; compteFenetre: number; fenetreDebut: Date; dernierMessage: string | null; notifieA: Date | null }[],
  maintenant: Date,
): IncidentAAlerter[] {
  const t = maintenant.getTime();
  return lignes
    .filter((l) => l.compteFenetre >= SEUIL)
    .filter((l) => t - l.fenetreDebut.getTime() <= FENETRE_MS)
    .filter((l) => !l.notifieA || t - l.notifieA.getTime() >= RAPPEL_MS)
    .sort((a, b) => b.compteFenetre - a.compteFenetre)
    .map(({ evenement, compteFenetre, dernierMessage }) => ({ evenement, compteFenetre, dernierMessage }));
}

/** Pur : le texte de la notification agrégée. */
export function texteAlerte(incidents: readonly IncidentAAlerter[]): { title: string; body: string } {
  const n = incidents.length;
  const lignes = incidents.slice(0, MAX_LISTES).map((i) => `• ${i.evenement} — ${i.compteFenetre} échec(s) dans l'heure`);
  if (n > MAX_LISTES) lignes.push(`… et ${n - MAX_LISTES} autre(s).`);
  return {
    title: n === 1 ? "⚠️ Une erreur se répète" : `⚠️ ${n} erreurs se répètent`,
    body: `${lignes.join("\n")}\nLes écrans concernés affichent un repli (liste vide, valeur par défaut) : détail dans Administration → Diagnostic.`,
  };
}

/** La tâche planifiée : une notification agrégée au Super Admin, au plus une par événement et par rappel. */
export async function alerterIncidentsRepetes(maintenant = new Date()): Promise<{ alertes: number }> {
  await verserCompteurs();
  const lignes = await prisma.incidentRepete.findMany({
    where: { compteFenetre: { gte: SEUIL }, fenetreDebut: { gte: new Date(maintenant.getTime() - FENETRE_MS) } },
    select: { evenement: true, compteFenetre: true, fenetreDebut: true, dernierMessage: true, notifieA: true },
    take: 200,
  });
  const aAlerter = incidentsAAlerter(lignes, maintenant);
  if (aAlerter.length === 0) return { alertes: 0 };

  // On marque AVANT d'envoyer : un envoi qui échoue à moitié ne doit pas resonner chaque minute.
  await prisma.incidentRepete.updateMany({ where: { evenement: { in: aAlerter.map((i) => i.evenement) } }, data: { notifieA: maintenant } });
  const { title, body } = texteAlerte(aAlerter);
  await notifyRoles(["SUPER_ADMIN"], { type: "GENERIC", title, body, link: "/admin/diagnostic" });
  journal.avertissement("incidents.alerte-envoyee", { evenements: aAlerter.map((i) => i.evenement) });
  return { alertes: aAlerter.length };
}

export type IncidentDiagnostic = {
  evenement: string;
  total: number;
  compteFenetre: number;
  fenetreActive: boolean;
  dernierA: Date;
  dernierMessage: string | null;
  notifieA: Date | null;
};

/** Pour le Diagnostic (Super Admin) : les incidents des sept derniers jours, le plus récent d'abord. */
export async function lireIncidentsRecents(maintenant = new Date()): Promise<IncidentDiagnostic[]> {
  const lignes = await prisma.incidentRepete
    .findMany({
      where: { dernierA: { gte: new Date(maintenant.getTime() - 7 * 24 * 60 * 60_000) } },
      orderBy: { dernierA: "desc" },
      take: 50,
    })
    .catch(sansBloquer("diagnostic.incidents", []));
  return lignes.map((l) => ({
    evenement: l.evenement,
    total: l.total,
    compteFenetre: l.compteFenetre,
    fenetreActive: maintenant.getTime() - l.fenetreDebut.getTime() <= FENETRE_MS,
    dernierA: l.dernierA,
    dernierMessage: l.dernierMessage,
    notifieA: l.notifieA,
  }));
}
