import { prisma } from "@/lib/prisma";
import { userCan } from "@/lib/rbac";
import { canAccessEntity } from "@/lib/entity-access";
import { createEvent, submitEventForApproval } from "@/modules/ad-pro/actions-evenements";
import { getAppSettings } from "@/lib/settings";
import { porteDgRequise } from "@/lib/seuils/ad-pro";
import type { CurrentUser } from "@/lib/session";
import { champs, dzd, liste, nombre, texte, type OperationIA, type PropositionOperation } from "../../domaine/operations/types";
import { lireMedecins, replier, valeurCommune } from "./annuaire-medical";
import { dateIso } from "./adpro-prise-en-charge";
import { avertissementBudget } from "./budget";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CRÉER ET SOUMETTRE UN ÉVÉNEMENT (Ad & Pro) — par les deux actions de l'écran, en une carte.
 *
 * `createEvent` le crée en brouillon (quinze champs obligatoires, tous nommés d'un coup par
 * l'action) ; `submitEventForApproval` l'engage dans le circuit. La personne confirme UNE fois.
 * Si la soumission est refusée après la création, le résultat le dit : l'événement existe en
 * brouillon et se soumet depuis sa fiche — on ne le recrée jamais.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

// UN ÉVÉNEMENT EXTERNE (Direction, 27/10) : les cinq types de l'écran (`events/externe.ts`), et qui l'organise.
const TYPES: Record<string, string> = {
  congres: "CONGRESS", staff: "HOSPITAL_STAFF", webinaire: "WEBINAR", journee: "SCIENTIFIC_DAY", "journee scientifique": "SCIENTIFIC_DAY", autre: "OTHER",
};
const LIBELLE_TYPE: Record<string, string> = {
  CONGRESS: "Congrès", SEMINAR: "Séminaire", ROUND_TABLE: "Table ronde", HOSPITAL_STAFF: "Staff hospitalier", SYMPOSIUM: "Symposium",
  WEBINAR: "Webinaire", TRAINING: "Formation", SCIENTIFIC_DAY: "Journée scientifique", OTHER: "Autre",
};
const FORMATS: Record<string, string> = { presentiel: "PRESENTIAL", "en ligne": "WEBINAR", webinaire: "WEBINAR", hybride: "HYBRID" };
const LIBELLE_FORMAT: Record<string, string> = { PRESENTIAL: "Présentiel", WEBINAR: "En ligne", HYBRID: "Hybride" };

/** Le responsable interne : « moi » par défaut, sinon un compte actif désigné sans ambiguïté. */
async function responsable(user: CurrentUser, nom: string): Promise<{ id: string; nom: string } | { manque: string }> {
  if (!nom || /^(moi|moi-m[eê]me|myself)$/i.test(nom)) return { id: user.id, nom: user.name };
  const t = await prisma.user.findMany({ where: { isActive: true, name: { contains: nom, mode: "insensitive" } }, select: { id: true, name: true }, take: 5 });
  const exact = t.filter((u) => replier(u.name) === replier(nom));
  const un = exact.length === 1 ? exact[0] : t.length === 1 ? t[0] : null;
  if (un) return { id: un.id, nom: un.name };
  return { manque: t.length > 1 ? `quel responsable interne : ${t.map((u) => u.name).join(", ")}` : `« ${nom} » n'a pas de compte actif : un autre responsable interne` };
}

export const EVENEMENT_CREATION: OperationIA = {
  nom: "preparer_evenement",
  module: "EVENTS",
  libelle: "Événement préparé",
  description:
    "PRÉPARE un ÉVÉNEMENT Ad & Pro et le SOUMET au circuit de validation, en une seule confirmation (mêmes actions que l'écran). "
    + "Appelle-la dès les premiers éléments : elle répond `manque` — pose alors UNE seule question. Elle pré-remplit la spécialité depuis "
    + "l'annuaire médical, cherche les doublons et dit le seuil du DG.",
  schema: {
    type: "object",
    properties: {
      nom: { type: "string" },
      type: { type: "string", description: "staff, webinaire, congrès, journée, autre." },
      organisateur: { type: "string", description: "Qui organise l'événement (société savante, hôpital, laboratoire…) — il est externe." },
      portee: { type: "string", enum: ["national", "international"] },
      format: { type: "string", enum: ["présentiel", "en ligne", "hybride"] },
      debut: { type: "string", description: "AAAA-MM-JJ" },
      fin: { type: "string", description: "AAAA-MM-JJ" },
      lieu: { type: "string", description: "Lieu / salle." },
      ville: { type: "string" },
      pays: { type: "string" },
      specialite: { type: "string" },
      medecins: { type: "string", description: "Médecins concernés (noms)." },
      produits: { type: "string" },
      budgetEstime: { type: "number", description: "Budget estimé en DZD (> 0)." },
      responsable: { type: "string", description: "Responsable interne : « moi » ou un nom." },
      description: { type: "string" },
    },
  },
  ouverte: (u) => userCan(u, "EVENTS", "CREATE"),

  async proposer(e, user): Promise<PropositionOperation> {
    const nomsMedecins = liste(e, "medecins");
    const lus = nomsMedecins.length ? await lireMedecins(user, nomsMedecins) : { connus: [], inconnus: [], ambigus: [] };
    if (lus.ambigus.length) return { manque: lus.ambigus.map((a) => `quel médecin pour « ${a.nom} » : ${a.candidats.join(", ")}`) };
    const specialite = texte(e, "specialite") || valeurCommune(lus.connus.map((m) => m.specialite));
    const type = TYPES[replier(texte(e, "type"))] ?? null;
    const p = replier(texte(e, "portee"));
    const portee = p.startsWith("inter") ? "INTERNATIONAL" : p.startsWith("nat") ? "NATIONAL" : null;
    const format = FORMATS[replier(texte(e, "format"))] ?? null;
    const debut = dateIso(texte(e, "debut"));
    const fin = dateIso(texte(e, "fin"));
    const budget = nombre(e, "budgetEstime");
    const resp = await responsable(user, texte(e, "responsable"));
    const produits = liste(e, "produits");

    const manque = [
      !texte(e, "nom") ? "le nom de l'événement" : null,
      !type ? "le type (staff, webinaire, congrès, journée, autre)" : null,
      !portee ? "la portée : nationale ou internationale" : null,
      !format ? "le format : présentiel, en ligne ou hybride" : null,
      !debut ? "la date de début" : null,
      !fin ? "la date de fin" : null,
      !texte(e, "lieu") ? "le lieu / la salle" : null,
      !texte(e, "ville") ? "la ville (wilaya)" : null,
      !texte(e, "pays") ? "le pays" : null,
      !specialite ? "la spécialité" : null,
      !nomsMedecins.length ? "le ou les médecins concernés" : null,
      !produits.length ? "le ou les produits concernés" : null,
      budget == null || budget <= 0 ? "le budget estimé (DZD, supérieur à zéro)" : null,
      "manque" in resp ? resp.manque : null,
      !texte(e, "description") ? "une courte description" : null,
    ].filter((x): x is string => x !== null);
    if (manque.length) return { manque };
    if (fin! < debut!) return { erreur: "La date de fin ne peut pas précéder la date de début." };
    const r = resp as { id: string; nom: string };

    const warnings: string[] = [];
    const proches = await prisma.event.findMany({
      where: { name: { equals: texte(e, "nom"), mode: "insensitive" }, createdAt: { gte: new Date(Date.now() - 365 * 24 * 3600 * 1000) } },
      select: { id: true, name: true, createdAt: true },
      take: 5,
    });
    const visibles = [];
    for (const x of proches) if (await canAccessEntity(user, "EVENT", x.id, "VIEW")) visibles.push(x);
    if (visibles.length) warnings.push(`Doublon possible : ${visibles.map((x) => `« ${x.name} » créé le ${x.createdAt.toLocaleDateString("fr-FR")}`).join(" ; ")}.`);
    const seuil = (await getAppSettings()).adProDgThreshold;
    if (porteDgRequise(budget, seuil)) warnings.push(`Au-delà du seuil de ${dzd(seuil)} : le Directeur Général validera aussi.`);
    if (lus.inconnus.length) warnings.push(`Hors annuaire médical (saisis tels quels) : ${lus.inconnus.join(", ")}.`);
    warnings.push(await avertissementBudget(user, budget));
    warnings.push("Créé puis soumis au circuit de validation dans la foulée.");

    return {
      carte: {
        title: `Événement — ${texte(e, "nom")}`,
        fields: champs([
          ["Type", LIBELLE_TYPE[type!]],
          ["Organisateur", texte(e, "organisateur") || null],
          ["Portée · format", `${portee === "NATIONAL" ? "Nationale" : "Internationale"} · ${LIBELLE_FORMAT[format!]}`],
          ["Dates", `${debut} → ${fin}`],
          ["Lieu", `${texte(e, "lieu")}, ${texte(e, "ville")} (${texte(e, "pays")})`],
          ["Spécialité", specialite],
          ["Médecin(s)", [...lus.connus.map((m) => m.nom), ...lus.inconnus].join(", ")],
          ["Produit(s)", produits.join(", ")],
          ["Budget estimé", dzd(budget!)],
          ["Responsable", r.nom],
        ]),
        warnings,
      },
      args: {
        name: texte(e, "nom"), type, scope: portee, format, startDate: debut, endDate: fin,
        location: texte(e, "lieu"), city: texte(e, "ville"), country: texte(e, "pays"), specialty: specialite,
        medecinsAnnuaire: JSON.stringify(lus.connus.map((m) => m.nom)), medecinsHorsAnnuaire: lus.inconnus.join("\n") || null,
        produits: JSON.stringify(produits), estimatedBudget: String(budget), responsibleId: r.id,
        description: texte(e, "description"), organizer: texte(e, "organisateur") || null,
      },
    };
  },

  async executer(a) {
    const fd = new FormData();
    for (const cle of ["name", "type", "scope", "format", "startDate", "endDate", "location", "city", "country", "specialty", "estimatedBudget", "responsibleId", "description", "organizer"]) {
      if (a[cle]) fd.set(cle, a[cle]!);
    }
    const lire = (v: string | null) => { try { return JSON.parse(v ?? "[]") as string[]; } catch { return []; } };
    for (const n of lire(a.medecinsAnnuaire)) fd.append("doctorIds", n);
    if (a.medecinsHorsAnnuaire) fd.set("doctorHorsAnnuaire", a.medecinsHorsAnnuaire);
    for (const p of lire(a.produits)) fd.append("productIds", p);
    const cree = await createEvent(fd);
    if (!cree.ok || !cree.id) return { ok: false, error: cree.error ?? "L'événement a été refusé." };
    const soumis = new FormData();
    soumis.set("id", cree.id);
    const s = await submitEventForApproval(soumis);
    const link = `/events/${cree.id}`;
    if (!s.ok) {
      return { ok: true, link, message: `Événement créé en brouillon, mais la soumission a été refusée : ${s.error ?? "raison non précisée"}. Soumettez-le depuis sa fiche.`, revalidate: ["/events"] };
    }
    return { ok: true, link, message: "Événement créé et soumis au circuit de validation.", revalidate: ["/events", "/ad-pro"] };
  },
};
