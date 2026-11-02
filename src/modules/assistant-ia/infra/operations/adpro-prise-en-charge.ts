import { prisma } from "@/lib/prisma";
import { scopeCongressIntl, scopeCongressNational, userCan } from "@/lib/rbac";
import { createCongressRequest } from "@/modules/ad-pro/actions-congres";
import { getAppSettings } from "@/lib/settings";
import { porteDgRequise } from "@/lib/seuils/ad-pro";
import { piecesAttendues } from "@/modules/ad-pro/partage";
import type { CurrentUser } from "@/lib/session";
import { champs, dzd, liste, nombre, texte, type OperationIA, type PropositionOperation } from "../../domaine/operations/types";
import { fichiersDepuisDrive, idsDe, resoudrePieces } from "./pieces";
import { lireMedecins, replier } from "./annuaire-medical";
import { avertissementBudget } from "./budget";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CRÉER UNE DEMANDE DE PRISE EN CHARGE (congrès national ou international) — par l'action de
 * l'écran (`createCongressRequest`).
 *
 * Les professionnels proposés sont des fiches de l'ANNUAIRE MÉDICAL (l'action crée pour chacun
 * sa fiche de prise en charge, billetterie et hôtellerie ouvertes) : un nom est donc résolu vers
 * UNE fiche que la personne voit, ou demandé — jamais deviné. Les pièces exigées de chaque
 * bénéficiaire (passeport ; visa et voyage à l'international) se déposent sur sa fiche après la
 * création : la carte les nomme. Le passeport n'est jamais lu par le modèle.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const TYPES: Record<string, string> = {
  congres: "CONGRESS", seminaire: "SEMINAR", "table ronde": "ROUND_TABLE", webinaire: "WEBINAR",
  atelier: "WORKSHOP", formation: "WORKSHOP", symposium: "SYMPOSIUM", staff: "STAFF", autre: "OTHER",
};
const LIBELLE_TYPE: Record<string, string> = {
  CONGRESS: "Congrès", SEMINAR: "Séminaire", ROUND_TABLE: "Table ronde", WEBINAR: "Webinaire",
  WORKSHOP: "Atelier", SYMPOSIUM: "Symposium", STAFF: "Staff", OTHER: "Autre",
};

/** « 2026-11-14 », « 14/11/2026 », « 14-11-2026 » → AAAA-MM-JJ, ou null. */
export function dateIso(v: string): string | null {
  const s = v.trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}-${m[2]!.padStart(2, "0")}-${m[3]!.padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) return `${m[3]}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
  return null;
}

const frDate = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });

export const PRISE_EN_CHARGE_CREATION: OperationIA = {
  nom: "preparer_prise_en_charge",
  module: "CONGRESS_NATIONAL",
  libelle: "Demande de prise en charge préparée",
  description:
    "PRÉPARE une demande de PRISE EN CHARGE (congrès national ou international, Ad & Pro), exécutée à la confirmation par l'action de l'écran. "
    + "Appelle-la dès les premiers éléments : elle répond `manque` — pose alors UNE seule question. Les médecins proposés sont cherchés dans "
    + "l'annuaire médical de l'utilisateur (un nom ambigu revient avec ses candidats). Elle cherche les doublons, dit le seuil du DG et les pièces "
    + "exigées de chaque bénéficiaire (passeport ; visa et voyage à l'international).",
  schema: {
    type: "object",
    properties: {
      perimetre: { type: "string", enum: ["national", "international"] },
      nom: { type: "string", description: "Nom de l'événement (congrès…)." },
      debut: { type: "string", description: "Date de début (AAAA-MM-JJ)." },
      fin: { type: "string", description: "Date de fin (AAAA-MM-JJ)." },
      ville: { type: "string" },
      pays: { type: "string", description: "Pays (international)." },
      institutionHote: { type: "string", description: "Institution hôte (national)." },
      typeEvenement: { type: "string", description: "congrès, séminaire, table ronde, webinaire, atelier, symposium, staff, autre." },
      initiative: { type: "string", enum: ["moi", "medecin"], description: "À l'origine : l'utilisateur, ou un médecin." },
      medecinsOrigine: { type: "string", description: "Si initiative du médecin : le ou les médecins à l'origine (noms)." },
      beneficiaires: { type: "string", description: "Les médecins proposés pour la prise en charge (noms, séparés par des virgules)." },
      mode: { type: "string", enum: ["individuelle", "groupe"] },
      budgetEstime: { type: "number", description: "Budget estimé, en DZD." },
      pieces: { type: "string", description: "Demande(s) écrite(s) ou autres pièces : noms ou identifiants de fichiers." },
    },
  },
  ouverte: (u) => userCan(u, "CONGRESS_NATIONAL", "CREATE") || userCan(u, "CONGRESS_INTERNATIONAL", "CREATE"),

  async proposer(e, user: CurrentUser): Promise<PropositionOperation> {
    const p = replier(texte(e, "perimetre"));
    const perimetre = p.startsWith("inter") ? "INTL" : p.startsWith("nat") ? "NATIONAL" : null;
    const nom = texte(e, "nom");
    const debut = dateIso(texte(e, "debut"));
    const fin = dateIso(texte(e, "fin"));
    const initiative = replier(texte(e, "initiative")).startsWith("med") ? "MEDECIN" : texte(e, "initiative") ? "DEMANDEUR" : null;
    const nomsOrigine = liste(e, "medecinsOrigine");
    const nomsBenef = liste(e, "beneficiaires");

    const manque = [
      !perimetre ? "le périmètre : congrès national ou international" : null,
      !nom ? "le nom de l'événement" : null,
      !debut ? "la date de début" : null,
      !fin ? "la date de fin" : null,
      perimetre === "INTL" && !texte(e, "pays") ? "le pays" : null,
      !texte(e, "ville") ? "la ville" : null,
      !initiative ? "qui est à l'origine de la demande : vous, ou un médecin" : null,
      initiative === "MEDECIN" && !nomsOrigine.length ? "le ou les médecins à l'origine de la demande" : null,
    ].filter((x): x is string => x !== null);
    if (manque.length) return { manque };
    if (perimetre === "INTL" ? !userCan(user, "CONGRESS_INTERNATIONAL", "CREATE") : !userCan(user, "CONGRESS_NATIONAL", "CREATE")) {
      return { erreur: `Vous ne pouvez pas créer de prise en charge ${perimetre === "INTL" ? "internationale" : "nationale"} à l'écran : l'assistant non plus.` };
    }
    if (fin! < debut!) return { erreur: "La date de fin ne peut pas précéder la date de début." };

    // LES MÉDECINS, résolus dans l'annuaire QUE LA PERSONNE VOIT.
    const lus = await lireMedecins(user, [...nomsOrigine, ...nomsBenef]);
    const aPreciser = [
      ...lus.ambigus.map((a) => `quel médecin pour « ${a.nom} » : ${a.candidats.join(", ")}`),
      ...lus.inconnus.map((n) => `« ${n} » n'est pas dans votre annuaire médical : un autre nom, ou l'ajouter d'abord à l'annuaire`),
    ];
    if (aPreciser.length) return { manque: aPreciser };
    const idDe = (n: string) => lus.connus.find((m) => replier(m.nom).includes(replier(n)) || replier(n).includes(replier(m.nom)))?.id;
    const origine = nomsOrigine.map(idDe).filter((x): x is string => !!x);
    const beneficiaires = nomsBenef.map(idDe).filter((x): x is string => !!x);

    const pieces = await resoudrePieces(user, liste(e, "pieces"));
    if ("erreur" in pieces) return { erreur: pieces.erreur };

    const typeBrut = replier(texte(e, "typeEvenement"));
    const eventType = TYPES[typeBrut] ?? (Object.values(TYPES).includes(texte(e, "typeEvenement")) ? texte(e, "typeEvenement") : "CONGRESS");
    const mode = replier(texte(e, "mode")).startsWith("gr") ? "GROUP" : "INDIVIDUAL";
    const budget = nombre(e, "budgetEstime");

    // LES CONTRÔLES AVANT DE REMPLIR.
    const warnings: string[] = [];
    const depuis = new Date(Date.now() - 365 * 24 * 3600 * 1000);
    const memeNom = { name: { equals: nom, mode: "insensitive" as const }, createdAt: { gte: depuis } };
    const proches = perimetre === "INTL"
      ? await prisma.congressInternational.findMany({ where: { AND: [scopeCongressIntl(user), memeNom] }, select: { name: true, createdAt: true }, take: 3 })
      : await prisma.congressNational.findMany({ where: { AND: [scopeCongressNational(user), memeNom] }, select: { name: true, createdAt: true }, take: 3 });
    if (proches.length) warnings.push(`Doublon possible : ${proches.map((x) => `« ${x.name} » créée le ${x.createdAt.toLocaleDateString("fr-FR")}`).join(" ; ")} — même événement, moins d'un an.`);
    const seuil = (await getAppSettings()).adProDgThreshold;
    if (budget != null && porteDgRequise(budget, seuil)) warnings.push(`Au-delà du seuil de ${dzd(seuil)} : le Directeur Général validera aussi.`);
    warnings.push(await avertissementBudget(user, budget));
    const exigees = piecesAttendues(perimetre === "INTL" ? "INTERNATIONAL" : "NATIONAL").map((x) => x.label.toLowerCase());
    if (beneficiaires.length) warnings.push(`Pièces exigées de chaque bénéficiaire, à déposer sur sa fiche après la création : ${exigees.join(", ")}.`);
    else warnings.push("Aucun bénéficiaire proposé : vous les ajouterez sur la demande, fiche par fiche.");

    const nomsDe = (ids: string[]) => ids.map((id) => lus.connus.find((m) => m.id === id)?.nom).filter(Boolean).join(", ");
    return {
      carte: {
        title: `Prise en charge ${perimetre === "INTL" ? "internationale" : "nationale"} — ${nom}`,
        fields: champs([
          ["Événement", `${nom} (${LIBELLE_TYPE[eventType] ?? eventType})`],
          ["Dates", `du ${frDate(debut!)} au ${frDate(fin!)}`],
          ["Lieu", [texte(e, "ville"), perimetre === "INTL" ? texte(e, "pays") : texte(e, "institutionHote")].filter(Boolean).join(" — ")],
          ["À l'origine", initiative === "MEDECIN" ? `Initiative du médecin : ${nomsDe(origine)}` : "Votre initiative"],
          ["Bénéficiaires proposés", beneficiaires.length ? nomsDe(beneficiaires) : null],
          ["Mode", mode === "GROUP" ? "De groupe" : "Individuelle"],
          ["Budget estimé", budget != null ? dzd(budget) : null],
          ["Pièces", pieces.length ? pieces.map((x) => x.nom).join(", ") : null],
        ]),
        warnings,
      },
      args: {
        type: perimetre, name: nom, debut, fin, city: texte(e, "ville"),
        country: perimetre === "INTL" ? texte(e, "pays") : null,
        hostInstitution: perimetre === "NATIONAL" ? texte(e, "institutionHote") || null : null,
        eventType, initiative, careMode: mode,
        origine: JSON.stringify(initiative === "MEDECIN" ? origine : []),
        beneficiaires: JSON.stringify(beneficiaires),
        estimatedBudget: budget != null ? String(budget) : null,
        pieces: JSON.stringify(pieces.map((x) => x.id)),
      },
    };
  },

  async executer(a, user) {
    const fichiers = await fichiersDepuisDrive(user, idsDe(a.pieces));
    if (!Array.isArray(fichiers)) return { ok: false, error: fichiers.erreur };
    const fd = new FormData();
    const intl = a.type === "INTL";
    fd.set("type", intl ? "INTL" : "NATIONAL");
    fd.set("name", a.name ?? "");
    fd.set(intl ? "startDate" : "date", a.debut ?? "");
    fd.set("endDate", a.fin ?? "");
    for (const [cle, champ] of [["city", "city"], ["country", "country"], ["hostInstitution", "hostInstitution"], ["eventType", "eventType"],
      ["initiative", "initiative"], ["careMode", "careMode"], ["estimatedBudget", "estimatedBudget"]] as const) {
      if (a[champ]) fd.set(cle, a[champ]!);
    }
    for (const id of idsDe(a.origine)) fd.append("initiativeDoctorIds", id);
    for (const id of idsDe(a.beneficiaires)) fd.append("invitedDoctorIds", id);
    for (const f of fichiers) fd.append("files", f);
    const r = await createCongressRequest(undefined, fd);
    if (!r.ok) return { ok: false, error: r.error ?? "La demande a été refusée." };
    const chemin = intl ? "/congress-international" : "/congress-national";
    return {
      ok: true,
      message: r.message ?? "Demande de prise en charge créée : elle part dans son circuit de validation.",
      ...(r.id ? { link: `${chemin}/${r.id}` } : {}),
      revalidate: [chemin, "/ad-pro"],
    };
  },
};
