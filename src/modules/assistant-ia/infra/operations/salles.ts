import { prisma } from "@/lib/prisma";
import { userCan } from "@/lib/rbac";
import { creerMoyenGeneral, reserverMoyenGeneral } from "@/modules/salles/actions";
import { conflitsDeReservation } from "@/modules/salles/api";
import { libelleInstant, lireCreneau } from "@/modules/salles/partage";
import { champs, nombre, texte, type OperationIA, type PropositionOperation } from "../../domaine/operations/types";
import { replier } from "./annuaire-medical";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES SALLES DE RÉUNION PAR L'ASSISTANT (lot T3, décision 0051) — réserver une salle (TOUT EMPLOYÉ, Direction 02/11/2026)
 * et déclarer une salle (l'assistante de direction, droit de créer « Moyens généraux »).
 *
 * Le serveur contrôle le CRÉNEAU avant la carte : aucun chevauchement, capacité suffisante ; une salle prise revient avec
 * les salles LIBRES et assez grandes ; sans salle désignée, la plus petite libre qui convient est choisie, et c'est dit.
 * Les actions de l'écran (`modules/salles/actions.ts`) écrivent, sous le journal des effets (annulables).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

type Salle = { id: string; reference: string; libelle: string; capacite: number | null };
const SELECT = { id: true, reference: true, libelle: true, capacite: true } as const;

/** Les salles ACTIVES désignées : référence, libellé exact, puis tous les mots du libellé (« conseil » → « Salle du conseil »). */
async function trouverSalles(q: string): Promise<Salle[]> {
  const actives = (await prisma.moyenGeneral.findMany({ where: { statut: "ACTIF", type: "SALLE" }, select: SELECT, take: 200 })) as Salle[];
  const r = replier(q.trim());
  if (!r) return actives;
  const ref = /mg\s?(\d{4})\s?(\d{1,5})/.exec(r);
  if (ref) return actives.filter((s) => s.reference === `MG-${ref[1]}-${ref[2]!.padStart(3, "0")}`);
  const exactes = actives.filter((s) => replier(s.libelle) === r);
  if (exactes.length) return exactes;
  const mots = r.split(/\s+/).filter((m) => m.length > 2 && !["salle", "salles", "reunion", "pour"].includes(m));
  return mots.length ? actives.filter((s) => mots.every((m) => replier(s.libelle).includes(m))) : [];
}

const places = (s: Salle) => (s.capacite ? ` (${s.capacite} places)` : "");

export const RESERVER_SALLE: OperationIA = {
  nom: "reserver_salle",
  module: "WORKSPACE",
  libelle: "Réservation de salle préparée",
  description:
    "RÉSERVE une SALLE DE RÉUNION sur un créneau (début AAAA-MM-JJTHH:MM, fin HH:MM ou date-heure ; heure d'Algérie). Ouvert à TOUS les employés. "
    + "Le serveur vérifie qu'elle est LIBRE et assez grande ; prise, il rend les autres salles libres. Sans salle précise (« une salle pour 12 personnes »), "
    + "il choisit la plus petite salle libre qui convient, et le dit.",
  schema: {
    type: "object",
    properties: {
      salle: { type: "string", description: "La salle : son nom (« salle du conseil ») ou sa référence. Vide : la plus petite salle libre qui convient." },
      debut: { type: "string", description: "AAAA-MM-JJTHH:MM (une date seule : la journée, 8 h → 18 h)." },
      fin: { type: "string", description: "HH:MM ou AAAA-MM-JJTHH:MM (vide : une heure)." },
      objet: { type: "string", description: "Comité de direction, rendez-vous client…" },
      participants: { type: "number" },
    },
  },
  // Tout employé réserve une salle (Direction, 02/11/2026) : la session suffit.
  ouverte: () => true,

  async proposer(e): Promise<PropositionOperation> {
    const manque = [!texte(e, "debut") ? "la date et l'heure de la réservation" : null, !texte(e, "objet") ? "l'objet de la réservation (réunion, rendez-vous…)" : null].filter((x): x is string => !!x);
    if (manque.length) return { manque };
    const creneau = lireCreneau(texte(e, "debut"), texte(e, "fin") || null);
    if (!creneau) return { erreur: "Le créneau est illisible ou sa fin précède son début (attendu : AAAA-MM-JJTHH:MM, fin HH:MM)." };
    const participants = nombre(e, "participants");
    const warnings: string[] = [];
    if (creneau.debut.getTime() < Date.now()) warnings.push("Le créneau commence dans le passé : vérifiez la date.");
    const libres = async (sauf?: string) => {
      const out: Salle[] = [];
      const toutes = (await prisma.moyenGeneral.findMany({ where: { statut: "ACTIF", type: "SALLE", ...(sauf ? { id: { not: sauf } } : {}) }, select: SELECT, orderBy: [{ capacite: "asc" }, { libelle: "asc" }] })) as Salle[];
      for (const s of toutes) if ((!participants || !s.capacite || s.capacite >= participants) && !(await conflitsDeReservation(s.id, creneau)).length) out.push(s);
      return out;
    };
    const alternatives = (ls: Salle[]) => (ls.length ? ` Libres sur ce créneau : ${ls.map((s) => `${s.libelle}${places(s)}`).join(", ")}.` : " Aucune autre salle n'est libre et assez grande sur ce créneau.");
    let choisie: Salle;
    if (texte(e, "salle")) {
      const ss = await trouverSalles(texte(e, "salle"));
      if (ss.length > 1) return { manque: [`quelle salle : ${ss.slice(0, 6).map((s) => `« ${s.libelle} »`).join(", ")}`] };
      if (!ss.length) return { erreur: `Aucune salle ne correspond à « ${texte(e, "salle")} ».${alternatives(await libres())}` };
      choisie = ss[0]!;
      if (participants && choisie.capacite && participants > choisie.capacite) return { erreur: `${choisie.libelle} compte ${choisie.capacite} places pour ${participants} participants.${alternatives(await libres(choisie.id))}` };
      const pris = await conflitsDeReservation(choisie.id, creneau);
      if (pris.length) return { erreur: `${choisie.libelle} est déjà réservée : ${pris.map((p) => `${libelleInstant(p.debut)} → ${libelleInstant(p.fin)} (${p.objet})`).join(" ; ")}.${alternatives(await libres(choisie.id))}` };
    } else {
      const ls = await libres();
      if (!ls.length) return { erreur: "Aucune salle n'est libre et assez grande sur ce créneau." };
      choisie = ls[0]!;
      warnings.push(`Salle choisie : ${choisie.libelle}, la plus petite libre${participants ? ` pour ${participants} personnes` : ""}.`);
    }
    return {
      carte: {
        title: `Réservation — ${choisie.libelle}`,
        fields: champs([
          ["Salle", `${choisie.libelle}${places(choisie)}`], ["Créneau", `${libelleInstant(creneau.debut)} → ${libelleInstant(creneau.fin)}`],
          ["Objet", texte(e, "objet")], ["Participants", participants !== null ? String(participants) : null], ["Disponibilité", "Libre (vérifié)"],
        ]),
        warnings, libelleBouton: "Réserver",
      },
      args: { moyenId: choisie.id, debut: creneau.debut.toISOString(), fin: creneau.fin.toISOString(), objet: texte(e, "objet"), participants: participants !== null ? String(participants) : null },
    };
  },

  async executer(a) {
    const fd = new FormData();
    // L'action relit le créneau en heure d'Algérie : on lui rend l'instant UTC en heure locale (UTC+1).
    const local = (iso: string) => new Date(new Date(iso).getTime() + 3_600_000).toISOString().slice(0, 16);
    fd.set("moyenId", a.moyenId!); fd.set("debut", local(a.debut!)); fd.set("fin", local(a.fin!)); fd.set("objet", a.objet!);
    if (a.participants) fd.set("participants", a.participants);
    const r = await reserverMoyenGeneral(undefined, fd);
    if (!r.ok) return { ok: false, error: r.error ?? "La réservation n'a pas pu être enregistrée." };
    return { ok: true, message: `${r.message ?? "Réservé."} Annulable en un geste.`, link: "/salles", revalidate: ["/salles"] };
  },
};

export const DECLARER_SALLE: OperationIA = {
  nom: "declarer_salle",
  module: "GENERAL_MEANS",
  libelle: "Salle déclarée",
  description: "DÉCLARE une SALLE DE RÉUNION (nom, capacité) pour qu'on puisse la réserver. Réservé à qui tient les moyens généraux (l'assistante de direction).",
  schema: { type: "object", properties: { nom: { type: "string" }, capacite: { type: "number", description: "Places." }, notes: { type: "string", description: "Équipement : écran, visio…" } } },
  ouverte: (u) => userCan(u, "GENERAL_MEANS", "CREATE"),

  async proposer(e): Promise<PropositionOperation> {
    if (!texte(e, "nom")) return { manque: ["le nom de la salle"] };
    const deja = (await trouverSalles(texte(e, "nom"))).filter((s) => replier(s.libelle) === replier(texte(e, "nom")));
    if (deja.length) return { erreur: `La salle « ${deja[0]!.libelle} » existe déjà${places(deja[0]!)}.` };
    const capacite = nombre(e, "capacite");
    return {
      carte: { title: `Nouvelle salle — ${texte(e, "nom")}`, fields: champs([["Salle", texte(e, "nom")], ["Capacité", capacite !== null ? `${capacite} places` : null], ["Équipement", texte(e, "notes") || null]]), warnings: [], libelleBouton: "Déclarer la salle" },
      args: { libelle: texte(e, "nom"), capacite: capacite !== null ? String(capacite) : null, notes: texte(e, "notes") || null },
    };
  },

  async executer(a) {
    const fd = new FormData();
    fd.set("type", "SALLE"); fd.set("libelle", a.libelle!);
    if (a.capacite) fd.set("capacite", a.capacite);
    if (a.notes) fd.set("notes", a.notes);
    const r = await creerMoyenGeneral(undefined, fd);
    return r.ok ? { ok: true, message: r.message ?? "Salle déclarée.", link: "/salles", revalidate: ["/salles"] } : { ok: false, error: r.error ?? "La salle n'a pas pu être déclarée." };
  },
};
