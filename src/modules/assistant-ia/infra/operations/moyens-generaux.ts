import { prisma } from "@/lib/prisma";
import { userCan } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import { creerMoyenGeneral, modifierMoyenGeneral, reserverMoyenGeneral } from "@/modules/moyens-generaux/actions";
import { conflitsDeReservation } from "@/modules/moyens-generaux/api";
import { LIBELLE_TYPE_MOYEN, libelleInstant, lireCreneau, lireTypeMoyen, TYPES_RESERVABLES, type TypeMoyen } from "@/modules/moyens-generaux/partage";
import { champs, dzd, nombre, texte, type OperationIA, type PropositionOperation } from "../../domaine/operations/types";
import { dateIso } from "./adpro-prise-en-charge";
import { replier } from "./annuaire-medical";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE SUIVI DES MOYENS GÉNÉRAUX PAR L'ASSISTANT (lot T3) — enregistrer ou mettre à jour une fiche du registre (véhicule,
 * assurance, contrat de prestataire, entretien, salle, équipement, fournitures) et RÉSERVER une salle ou un véhicule.
 *
 * Le serveur désigne la fiche (référence MG-…, immatriculation, numéro de contrat, libellé — parmi les fiches ACTIVES),
 * décide création ou modification (une fiche qui existe se MET À JOUR, jamais un doublon), montre la différence avant
 * → après, et pour une réservation contrôle le CRÉNEAU (aucun chevauchement, capacité) AVANT la carte : un créneau pris
 * revient avec les salles libres de même nature. Les actions de l'écran (`moyens-generaux-registre-actions`) écrivent,
 * sous le journal des effets.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

type Moyen = { id: string; reference: string; type: TypeMoyen; libelle: string; identifiant: string | null; prestataire: string | null; montant: unknown; echeance: Date | null; capacite: number | null; periodicite: string | null; rappelJours: number };
const SELECT = { id: true, reference: true, type: true, libelle: true, identifiant: true, prestataire: true, montant: true, echeance: true, capacite: true, periodicite: true, rappelJours: true } as const;

/** La fiche ACTIVE désignée : référence, identifiant (immatriculation, n° de contrat), libellé exact, puis libellé contenu. */
export async function trouverMoyen(q: string, type?: TypeMoyen | null): Promise<Moyen[]> {
  const s = q.trim();
  if (!s) return [];
  const ref = /MG[\s-]?(\d{4})[\s-]?(\d{1,5})/i.exec(s);
  if (ref) return prisma.moyenGeneral.findMany({ where: { reference: `MG-${ref[1]}-${ref[2]!.padStart(3, "0")}`, statut: "ACTIF" }, select: SELECT }) as Promise<Moyen[]>;
  const actifs = (await prisma.moyenGeneral.findMany({ where: { statut: "ACTIF", ...(type ? { type } : {}) }, select: SELECT, take: 500 })) as Moyen[];
  const r = replier(s);
  const compact = (x: string | null) => replier(x ?? "").replace(/\s+/g, "");
  const parId = actifs.filter((m) => m.identifiant && compact(m.identifiant) === compact(s));
  if (parId.length) return parId;
  const exacts = actifs.filter((m) => replier(m.libelle) === r);
  if (exacts.length) return exacts;
  const mots = r.split(/\s+/).filter((m) => m.length > 2);
  return actifs.filter((m) => { const l = replier(`${m.libelle} ${m.identifiant ?? ""} ${m.prestataire ?? ""}`); return mots.length > 0 && mots.every((w) => l.includes(w)); });
}

async function responsableDe(user: CurrentUser, qui: string): Promise<{ id: string; nom: string } | { manque: string } | null> {
  const s = qui.trim();
  if (!s) return null;
  if (/^(moi|moi-meme|moi meme|me)$/i.test(s)) return { id: user.id, nom: user.name ?? "moi" };
  const mots = replier(s).split(/\s+/).filter(Boolean);
  const us = (await prisma.user.findMany({ where: { isActive: true, AND: mots.map((m) => ({ name: { contains: m, mode: "insensitive" as const } })) }, select: { id: true, name: true }, take: 4 }));
  if (us.length === 1) return { id: us[0]!.id, nom: us[0]!.name };
  return { manque: us.length ? `quel responsable : ${us.map((u) => u.name).join(", ")}` : `le responsable « ${s} » n'est pas dans l'annuaire : donnez son nom exact` };
}

const jour = (d: Date | null) => (d ? d.toISOString().slice(0, 10).split("-").reverse().join("/") : "—");
const CHAMPS_FICHE = ["prestataire", "identifiant", "periodicite", "notes", "description"] as const;

export const MOYEN_GENERAL_ENREGISTRER: OperationIA = {
  nom: "enregistrer_moyen_general",
  module: "GENERAL_MEANS",
  libelle: "Fiche des moyens généraux préparée",
  description:
    "ENREGISTRE OU MET À JOUR une fiche du REGISTRE DES MOYENS GÉNÉRAUX : véhicule (immatriculation), assurance (police, assureur, prime, échéance), "
    + "contrat de prestataire (ménage, gardiennage, maintenance, loyer), entretien (vidange, contrôle technique — rattaché à son véhicule), salle (capacité), équipement, fournitures. "
    + "Une fiche qui existe déjà (même référence MG-…, immatriculation, n° de contrat ou libellé) est MISE À JOUR, jamais dupliquée. Dates AAAA-MM-JJ, montants en DZD.",
  schema: {
    type: "object",
    properties: {
      fiche: { type: "string", description: "Pour une MISE À JOUR : la référence MG-…, l'immatriculation, le n° de contrat ou le libellé de la fiche existante." },
      type: { type: "string", description: "véhicule, assurance, contrat de prestataire, entretien, salle, équipement, fournitures, autre" },
      libelle: { type: "string" }, prestataire: { type: "string", description: "Prestataire, assureur, garage, loueur." },
      identifiant: { type: "string", description: "Immatriculation, n° de police ou de contrat, n° de série." },
      montant: { type: "number", description: "DZD" }, periodicite: { type: "string", description: "mensuel, trimestriel, annuel, ponctuel" },
      dateDebut: { type: "string" }, echeance: { type: "string", description: "Prochaine échéance (fin de contrat, renouvellement, prochain entretien)." },
      rappelJours: { type: "number", description: "Alerter combien de jours avant l'échéance (30 par défaut)." },
      capacite: { type: "number", description: "Places d'une salle." },
      rattacheA: { type: "string", description: "Le véhicule (ou moyen) auquel se rattache une assurance ou un entretien : immatriculation, référence ou libellé." },
      responsable: { type: "string", description: "Nom du responsable, ou « moi »." }, notes: { type: "string" },
    },
  },
  ouverte: (u) => userCan(u, "GENERAL_MEANS", "CREATE") || userCan(u, "GENERAL_MEANS", "UPDATE"),

  async proposer(e, user): Promise<PropositionOperation> {
    const typeBrut = texte(e, "type");
    const type = typeBrut ? lireTypeMoyen(typeBrut) : null;
    if (typeBrut && !type) return { erreur: `Nature « ${typeBrut} » inconnue : véhicule, assurance, contrat de prestataire, entretien, salle, équipement, fournitures ou autre.` };
    const desig = texte(e, "fiche");
    const existants = desig ? await trouverMoyen(desig) : [];
    if (desig && existants.length > 1) return { manque: [`quelle fiche : ${existants.slice(0, 5).map((m) => `${m.reference} « ${m.libelle} »`).join(", ")}`] };
    if (desig && !existants.length) return { erreur: `Aucune fiche active du registre ne correspond à « ${desig} ». Pour la créer, donnez sa nature et son libellé (sans « fiche »).` };
    let cible = existants[0] ?? null;
    // Une CRÉATION qui retrouve une fiche identique devient sa mise à jour (jamais un doublon).
    if (!cible && texte(e, "libelle") && type) {
      const memes = (await trouverMoyen(texte(e, "identifiant") || texte(e, "libelle"), type)).filter((m) => !texte(e, "identifiant") || m.identifiant);
      if (memes.length === 1) cible = memes[0]!;
    }
    if (!cible && (!type || !texte(e, "libelle"))) return { manque: [!type ? "la nature du moyen (véhicule, assurance, contrat de prestataire, entretien, salle…)" : "le libellé de la fiche"] };
    if (cible && !userCan(user, "GENERAL_MEANS", "UPDATE")) return { erreur: "Mettre à jour le registre demande le droit de modifier « Moyens généraux »." };
    if (!cible && !userCan(user, "GENERAL_MEANS", "CREATE")) return { erreur: "Créer une fiche du registre demande le droit de créer dans « Moyens généraux »." };

    const args: Record<string, string | null> = {};
    const fields: [string, string | null][] = [];
    const warnings: string[] = [];
    for (const k of CHAMPS_FICHE) if (texte(e, k)) args[k] = texte(e, k);
    const montant = nombre(e, "montant");
    if (montant !== null) { if (montant < 0) return { erreur: "Un montant ne peut pas être négatif." }; args.montant = String(montant); }
    for (const k of ["dateDebut", "echeance"] as const) {
      if (!texte(e, k)) continue;
      const d = dateIso(texte(e, k));
      if (!d) return { erreur: `Date « ${texte(e, k)} » illisible (attendu : JJ/MM/AAAA ou AAAA-MM-JJ).` };
      args[k] = d;
    }
    if (args.echeance && args.dateDebut && args.echeance < args.dateDebut) return { erreur: "L'échéance précède la date de début." };
    if (args.echeance && args.echeance < new Date().toISOString().slice(0, 10)) warnings.push("L'échéance est déjà dépassée : la fiche apparaîtra en alerte.");
    const rappel = nombre(e, "rappelJours");
    if (rappel !== null) args.rappelJours = String(rappel);
    const capacite = nombre(e, "capacite");
    if (capacite !== null) args.capacite = String(capacite);
    if (texte(e, "rattacheA")) {
      const p = await trouverMoyen(texte(e, "rattacheA"));
      if (p.length !== 1) return p.length ? { manque: [`à quel moyen rattacher : ${p.slice(0, 5).map((m) => `${m.reference} « ${m.libelle} »`).join(", ")}`] } : { erreur: `Aucune fiche active ne correspond à « ${texte(e, "rattacheA")} » pour le rattachement : enregistrez-la d'abord.` };
      args.parentId = p[0]!.id;
      fields.push(["Rattaché à", `${p[0]!.reference} — ${p[0]!.libelle}${p[0]!.identifiant ? ` (${p[0]!.identifiant})` : ""}`]);
    }
    if (texte(e, "responsable")) {
      const r = await responsableDe(user, texte(e, "responsable"));
      if (r && "manque" in r) return { manque: [r.manque] };
      if (r) { args.responsableId = r.id; fields.push(["Responsable", r.nom]); }
    }

    if (cible) {
      if (type && type !== cible.type) args.type = type;
      if (texte(e, "libelle") && texte(e, "libelle") !== cible.libelle) args.libelle = texte(e, "libelle");
      const avantApres: [string, string | null][] = [];
      const diff = (lib: string, avant: string | null, apres: string | undefined | null) => { if (apres !== undefined && apres !== null && apres !== (avant ?? "")) avantApres.push([lib, `${avant || "—"} → ${apres}`]); };
      diff("Nature", LIBELLE_TYPE_MOYEN[cible.type], args.type ? LIBELLE_TYPE_MOYEN[args.type as TypeMoyen] : undefined);
      diff("Libellé", cible.libelle, args.libelle);
      diff("Prestataire", cible.prestataire, args.prestataire);
      diff("Identifiant", cible.identifiant, args.identifiant);
      diff("Montant", cible.montant != null ? dzd(Number(cible.montant)) : null, args.montant ? dzd(Number(args.montant)) : undefined);
      diff("Périodicité", cible.periodicite, args.periodicite);
      diff("Échéance", jour(cible.echeance), args.echeance ? jour(new Date(args.echeance)) : undefined);
      diff("Rappel", `${cible.rappelJours} j`, args.rappelJours ? `${args.rappelJours} j` : undefined);
      diff("Capacité", cible.capacite != null ? String(cible.capacite) : null, args.capacite);
      if (!avantApres.length && !fields.length && !args.notes && !args.description && !args.dateDebut) return { erreur: `${cible.reference} « ${cible.libelle} » est déjà à jour : rien à changer.` };
      return {
        carte: {
          title: `Mise à jour de ${cible.reference} — ${cible.libelle}`,
          fields: champs([["Fiche", `${cible.reference} · ${LIBELLE_TYPE_MOYEN[cible.type]}`], ...avantApres, ...fields, ["Notes", args.notes ?? null]]),
          warnings, libelleBouton: "Mettre à jour la fiche",
        },
        args: { ...args, id: cible.id, mode: "modifier" },
      };
    }
    args.type = type!;
    args.libelle = texte(e, "libelle");
    return {
      carte: {
        title: `Nouvelle fiche — ${LIBELLE_TYPE_MOYEN[type!]} « ${args.libelle} »`,
        fields: champs([
          ["Nature", LIBELLE_TYPE_MOYEN[type!]], ["Libellé", args.libelle], ["Prestataire", args.prestataire ?? null], ["Identifiant", args.identifiant ?? null],
          ["Montant", args.montant ? `${dzd(Number(args.montant))}${args.periodicite ? ` (${args.periodicite})` : ""}` : null],
          ["Début", args.dateDebut ? jour(new Date(args.dateDebut)) : null], ["Échéance", args.echeance ? `${jour(new Date(args.echeance))} — rappel ${args.rappelJours ?? 30} j avant` : null],
          ["Capacité", args.capacite ? `${args.capacite} places` : null], ...fields, ["Notes", args.notes ?? null],
        ]),
        warnings, libelleBouton: "Enregistrer au registre",
      },
      args: { ...args, mode: "creer" },
    };
  },

  async executer(a) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(a)) if (v !== null && k !== "mode") fd.set(k, v);
    const r = a.mode === "modifier" ? await modifierMoyenGeneral(undefined, fd) : await creerMoyenGeneral(undefined, fd);
    if (!r.ok) return { ok: false, error: r.error ?? "La fiche n'a pas pu être enregistrée." };
    return { ok: true, message: r.message ?? "Fiche enregistrée.", link: "/moyens-generaux/registre", revalidate: ["/moyens-generaux/registre"] };
  },
};

export const MOYEN_GENERAL_RESERVER: OperationIA = {
  nom: "reserver_moyen_general",
  module: "GENERAL_MEANS",
  libelle: "Réservation de salle ou de véhicule préparée",
  description:
    "RÉSERVE une SALLE ou un VÉHICULE du registre des moyens généraux sur un créneau (début AAAA-MM-JJTHH:MM, fin HH:MM ou date-heure ; heure d'Algérie). "
    + "Le serveur vérifie qu'il est LIBRE (aucun chevauchement) et assez grand ; pris, il rend les autres salles libres de même nature. "
    + "Sans salle précise (« une salle pour 12 personnes »), il choisit la plus petite salle libre assez grande, et le dit.",
  schema: {
    type: "object",
    properties: {
      moyen: { type: "string", description: "La salle ou le véhicule : libellé, référence MG-… ou immatriculation. Vide : la plus petite salle libre qui convient." },
      debut: { type: "string", description: "AAAA-MM-JJTHH:MM (une date seule : la journée)." },
      fin: { type: "string", description: "HH:MM ou AAAA-MM-JJTHH:MM (vide : une heure)." },
      objet: { type: "string", description: "Comité de direction, visite client…" },
      participants: { type: "number" },
    },
  },
  ouverte: (u) => userCan(u, "GENERAL_MEANS", "VIEW"),

  async proposer(e): Promise<PropositionOperation> {
    const manque = [!texte(e, "debut") ? "la date et l'heure de la réservation" : null, !texte(e, "objet") ? "l'objet de la réservation (réunion, déplacement…)" : null].filter((x): x is string => !!x);
    if (manque.length) return { manque };
    const creneau = lireCreneau(texte(e, "debut"), texte(e, "fin") || null);
    if (!creneau) return { erreur: "Le créneau est illisible ou sa fin précède son début (attendu : AAAA-MM-JJTHH:MM, fin HH:MM)." };
    const participants = nombre(e, "participants");
    const warnings: string[] = [];
    if (creneau.debut.getTime() < Date.now()) warnings.push("Le créneau commence dans le passé : vérifiez la date.");
    let choisi: Moyen | null = null;
    const libres = async (type: TypeMoyen, sauf?: string) => {
      const ms = (await prisma.moyenGeneral.findMany({ where: { statut: "ACTIF", type, ...(sauf ? { id: { not: sauf } } : {}) }, select: SELECT, orderBy: [{ capacite: "asc" }, { libelle: "asc" }] })) as Moyen[];
      const out: Moyen[] = [];
      for (const m of ms) if ((!participants || !m.capacite || m.capacite >= participants) && !(await conflitsDeReservation(m.id, creneau)).length) out.push(m);
      return out;
    };
    if (texte(e, "moyen")) {
      const ms = (await trouverMoyen(texte(e, "moyen"))).filter((m) => TYPES_RESERVABLES.includes(m.type));
      if (ms.length > 1) return { manque: [`quel moyen : ${ms.slice(0, 5).map((m) => `« ${m.libelle} »`).join(", ")}`] };
      if (!ms.length) return { erreur: `Aucune salle ni véhicule actif du registre ne correspond à « ${texte(e, "moyen")} ».` };
      choisi = ms[0]!;
      if (participants && choisi.capacite && participants > choisi.capacite) {
        const autres = await libres(choisi.type, choisi.id);
        return { erreur: `${choisi.libelle} compte ${choisi.capacite} places pour ${participants} participants.${autres.length ? ` Libres et assez grandes sur ce créneau : ${autres.map((m) => `${m.libelle}${m.capacite ? ` (${m.capacite} places)` : ""}`).join(", ")}.` : ""}` };
      }
      const pris = await conflitsDeReservation(choisi.id, creneau);
      if (pris.length) {
        const autres = await libres(choisi.type, choisi.id);
        return { erreur: `${choisi.libelle} est déjà réservé(e) : ${pris.map((p) => `${libelleInstant(p.debut)} → ${libelleInstant(p.fin)} (${p.objet})`).join(" ; ")}.${autres.length ? ` Libres sur ce créneau : ${autres.map((m) => `${m.libelle}${m.capacite ? ` (${m.capacite} places)` : ""}`).join(", ")}.` : " Aucun autre moyen de même nature n'est libre."}` };
      }
    } else {
      const ls = await libres("SALLE");
      if (!ls.length) return { erreur: "Aucune salle du registre n'est libre et assez grande sur ce créneau." };
      choisi = ls[0]!;
      warnings.push(`Salle choisie : ${choisi.libelle}, la plus petite libre${participants ? ` pour ${participants} personnes` : ""}.`);
    }
    return {
      carte: {
        title: `Réservation — ${choisi.libelle}`,
        fields: champs([
          [LIBELLE_TYPE_MOYEN[choisi.type], `${choisi.libelle}${choisi.capacite ? ` (${choisi.capacite} places)` : ""}${choisi.identifiant ? ` — ${choisi.identifiant}` : ""}`],
          ["Créneau", `${libelleInstant(creneau.debut)} → ${libelleInstant(creneau.fin)}`], ["Objet", texte(e, "objet")],
          ["Participants", participants !== null ? String(participants) : null], ["Disponibilité", "Libre (vérifié)"],
        ]),
        warnings, libelleBouton: "Réserver",
      },
      args: { moyenId: choisi.id, debut: creneau.debut.toISOString(), fin: creneau.fin.toISOString(), objet: texte(e, "objet"), participants: participants !== null ? String(participants) : null },
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
    return { ok: true, message: r.message ?? "Réservé.", link: "/moyens-generaux/registre", revalidate: ["/moyens-generaux/registre"] };
  },
};
