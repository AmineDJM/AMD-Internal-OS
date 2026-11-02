/**
 * OPS VAGUE 4b — ANNUAIRE MÉDICAL, première famille : visites (saisie terrain, création, PATCH
 * par champs soumis, suppression), praticiens en FUSION intégrale, suppressions/restaurations en
 * lot bornées par la portée, cellules type feuille et leur couleur, établissements, spécialités.
 */
import { prisma } from "./erp";
import { createDoctor, updateDoctor, deleteDoctor, createVisit, updateVisit, deleteVisit, deleteInstitution, createSpecialty, updateSpecialty, deleteSpecialty, logVisit } from "@/lib/actions/medical-actions";
import { addDirectoryDoctor, saveDirectoryCell, saveDirectoryCustomCell, deleteDirectoryDoctors, restaurerDirectoryDoctors } from "@/lib/actions/medical-directory-actions";
import { colorerCellulesAnnuaire, isAnnuaireField, isEtablissementField } from "@/platform/in-process/capacites";
import { COULEURS_CELLULE, estCouleurCellule } from "@/lib/grille/couleurs";
import type { OpImpl, OpProposalDraft } from "../../types";
import { opStr } from "../../types";
import { runFd, runFd2, fieldsOf, resolveOne, isoDate } from "../../helpers";
import { matchLabel, fold } from "../../impl-regulatory";
import { day, resolvePerson, resolveDoctor } from "./commun";

const resolveInstitution = (raw: string) =>
  resolveOne(raw, "l'établissement (champ « institution »)",
    (q) => prisma.medicalInstitution.findMany({ where: { name: { contains: q, mode: "insensitive" } }, select: { id: true, name: true }, take: 6 }),
    (i) => i.name);

const resolveSpecialty = (raw: string) =>
  resolveOne(raw, "la spécialité (champ « specialty »)",
    (q) => prisma.medicalSpecialty.findMany({ where: { name: { contains: q, mode: "insensitive" } }, select: { id: true, name: true }, take: 6 }),
    (s) => s.name);

const TITLE_FR: [string, string][] = [
  ["PROFESSEUR", "Professeur"], ["MAITRE_CONFERENCES", "Maître de conférences"],
  ["MAITRE_ASSISTANT", "Maître assistant"], ["PRATICIEN_SPECIALISTE", "Praticien spécialiste"],
  ["ASSISTANT", "Assistant"], ["RESIDENT", "Résident"], ["GENERALISTE", "Généraliste"],
  ["PHARMACIEN", "Pharmacien"], ["AUTRE", "Autre"],
];
const SECTOR_FR: [string, string][] = [["HOSPITAL", "Hospitalier"], ["LIBERAL", "Libéral"], ["BOTH", "Les deux"]];
const SEGMENT_FR: [string, string][] = [
  ["VERY_HIGH", "Très élevé"], ["HIGH", "Élevé"], ["MEDIUM", "Moyen"], ["LOW", "Faible"], ["VERY_LOW", "Très faible"],
];
const VISIT_STATUS_FR: [string, string][] = [
  ["PLANNED", "Planifiée"], ["COMPLETED", "Réalisée"], ["CANCELLED", "Annulée"], ["POSTPONED", "Reportée"],
];

/**
 * UNE VISITE FAITE NE S'ENREGISTRE PAS PAR create_visit / update_visit (§118.71).
 *
 * Les actions qu'appellent ces deux opérations PLANIFIENT : elles refusent désormais le statut
 * « réalisée », parce qu'elles ne tiennent ni la fenêtre de 48 h, ni les produits de la gamme, ni le
 * matériel remis. Le refus est posé AVANT la carte — une carte qu'on confirme puis qu'on voit
 * refuser est un geste offert puis retiré (§118.83) — et il nomme l'opération qui sait faire :
 * c'est le PLANIFICATEUR qui lit ce refus, pas une personne devant un écran (§118.69).
 */
const REFUS_FAITE_PAR_LOG_VISIT =
  "Une visite FAITE ne s'enregistre pas par cette opération : passez par log_visit (la saisie de « Ma journée », dans les 48 h, "
  + "produits de la gamme) ou par le rapport de la visite planifiée. Cette opération planifie, reporte ou annule.";

function enumIn(raw: string, entries: [string, string][]): string | null | { error: string } {
  const q = raw.trim();
  if (!q) return null;
  return matchLabel(q, entries);
}

interface VisitHit { id: string; date: Date; doctorName: string }

async function resolveVisit(raw: string, dateRaw: string): Promise<VisitHit | { error: string }> {
  const doctor = await resolveDoctor(raw);
  if ("error" in doctor) return doctor;
  const date = isoDate(dateRaw);
  const rows = await prisma.medicalVisit.findMany({
    where: {
      doctorId: doctor.id,
      ...(date ? { date: { gte: new Date(`${date}T00:00:00Z`), lt: new Date(new Date(`${date}T00:00:00Z`).getTime() + 86_400_000) } } : {}),
    },
    select: { id: true, date: true, status: true },
    orderBy: { date: "desc" }, take: 6,
  });
  if (rows.length === 0) return { error: `Aucune visite pour ${doctor.name}${date ? ` le ${date}` : ""}.` };
  if (rows.length > 1) return { error: `Plusieurs visites pour ${doctor.name} : ${rows.map((v) => `${day(v.date)} (${VISIT_STATUS_FR.find(([c]) => c === v.status)?.[1] ?? v.status})`).join(" ; ")} — préciser la date (champ « date »).` };
  return { id: rows[0].id, date: rows[0].date, doctorName: doctor.name };
}

// ─────────────────────────── ANNUAIRE MÉDICAL ───────────────────────────

export const MEDICAL_FICHES_OPS_IMPL: Record<string, OpImpl> = {
  /**
   * SAISIR UNE VISITE FAITE — le geste quotidien du terrain, disponible à la voix.
   *
   * « J'ai vu le professeur Benali, je lui ai présenté l'Atorvastatine » depuis la voiture vaut
   * mieux qu'une saisie remise au soir puis oubliée. L'action canonique (`logVisit`) revérifie
   * tout : le praticien doit être dans le panel de celui qui parle, la visite est TERMINÉE par
   * construction, et la date ne peut pas être future.
   */
  log_visit: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      // LA RECHERCHE SE FAIT DANS SON PANEL, et nulle part ailleurs. Deux raisons, et la
      // seconde est la vraie : (1) elle évite une carte de confirmation que l'action refuserait
      // ensuite ; (2) `logVisit` crédite CELUI QUI SAISIT — chercher hors du panel laisserait
      // un superviseur enregistrer, sous son propre nom, la visite d'un de ses délégués, et
      // fausserait les deux compteurs à la fois. Une visite se saisit par celui qui l'a faite.
      const hit = await resolveOne(
        opStr(input, "doctor"),
        "le praticien de VOTRE panel (champ « doctor » — son nom)",
        (q) => prisma.medicalDoctor.findMany({
          where: { delegateId: user.id, name: { contains: q, mode: "insensitive" } },
          select: { id: true, name: true, specialty: true, institution: true }, take: 6,
        }),
        (d) => `${d.name}${d.specialty ? ` (${d.specialty})` : ""}${d.institution ? ` — ${d.institution}` : ""}`,
      );
      if ("error" in hit) return hit;

      // Les produits se donnent par NOM et se résolvent contre le catalogue canonique : un nom
      // qui ne correspond à rien est DIT, jamais enregistré en texte libre.
      const noms = opStr(input, "products").split(/[,;]/).map((x) => x.trim()).filter(Boolean);
      const produits: { id: string; name: string }[] = [];
      const inconnus: string[] = [];
      for (const n of noms) {
        const rows = await prisma.product.findMany({
          where: { canonicalName: { contains: n, mode: "insensitive" } },
          select: { id: true, canonicalName: true }, take: 3,
        });
        if (rows.length === 1) produits.push({ id: rows[0].id, name: rows[0].canonicalName });
        else inconnus.push(rows.length > 1 ? `${n} (plusieurs correspondances)` : n);
      }
      if (inconnus.length) {
        return { error: `Produit non reconnu : ${inconnus.join(" ; ")}. Donnez le nom exact, ou omettez le champ « products ».` };
      }

      const date = isoDate(opStr(input, "date"));
      return {
        title: `Visite faite — ${hit.name}`,
        fields: fieldsOf([
          ["Praticien", hit.name],
          ["Date", date ?? "aujourd'hui"],
          ["Produits présentés", produits.length ? produits.map((p) => p.name).join(", ") : null],
          ["Compte rendu", opStr(input, "notes") || null],
          ["À faire ensuite", opStr(input, "followUp") || null],
        ]),
        warnings: ["La visite est enregistrée comme FAITE — elle entre aussitôt dans votre réalisé du mois."],
        args: {
          doctorId: hit.id, doctorName: hit.name, date,
          productIds: produits.map((p) => p.id).join(","),
          report: opStr(input, "notes") || null,
          followUp: opStr(input, "followUp") || null,
        },
        successMessage: `Visite chez ${hit.name} enregistrée.`,
        link: "/medical/ma-journee",
        revalidate: ["/medical/ma-journee", "/planning/pilotage"],
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("doctorId", args.doctorId ?? "");
      if (args.date) fd.set("date", args.date);
      if (args.report) fd.set("report", args.report);
      if (args.followUp) fd.set("followUpActions", args.followUp);
      for (const id of (args.productIds ?? "").split(",").filter(Boolean)) fd.append("productId", id);
      const r = await logVisit(undefined, fd);
      if (!r.ok) return { ok: false, error: r.error ?? "L'enregistrement de la visite a été refusé." };
      return { ok: true, createdId: r.id, link: "/medical/ma-journee", revalidate: ["/medical/ma-journee", "/planning/pilotage"] };
    },
  },

  create_doctor: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const name = opStr(input, "doctor") || opStr(input, "name");
      if (!name) return { error: "Précisez le nom du praticien (champ « doctor »)." };
      const title = enumIn(opStr(input, "title"), TITLE_FR);
      if (title && typeof title === "object") return title;
      const sector = enumIn(opStr(input, "sector"), SECTOR_FR);
      if (sector && typeof sector === "object") return sector;
      let delegateId: string | null = null; let delegateName: string | null = null;
      if (opStr(input, "person")) {
        const delegate = await resolvePerson(opStr(input, "person"), "le délégué (champ « person »)");
        if ("error" in delegate) return delegate;
        delegateId = delegate.id; delegateName = delegate.name;
      }
      return {
        title: `Nouveau praticien « ${name} »`,
        fields: fieldsOf([
          ["Praticien", name],
          ["Grade", title ? TITLE_FR.find(([c]) => c === title)?.[1] ?? null : null],
          ["Spécialité", opStr(input, "specialty") || null],
          ["Secteur", sector ? SECTOR_FR.find(([c]) => c === sector)?.[1] ?? null : null],
          ["Établissement", opStr(input, "institution") || null],
          ["Wilaya", opStr(input, "wilaya") || opStr(input, "city") || null], ["Région", opStr(input, "region") || null],
          ["Téléphone", opStr(input, "phone") || null], ["E-mail", opStr(input, "email") || null],
          ["Délégué", delegateName],
        ]),
        args: {
          name, title: (title as string | null), specialty: opStr(input, "specialty") || null,
          sector: (sector as string | null), institution: opStr(input, "institution") || null,
          // La ville a quitté l'annuaire : ce qu'on disait « ville » se lit comme une wilaya, que
          // l'action ramène au nom officiel ou refuse.
          wilaya: opStr(input, "wilaya") || opStr(input, "city") || null, region: opStr(input, "region") || null,
          phone: opStr(input, "phone") || null, email: opStr(input, "email") || null,
          targetProducts: opStr(input, "products") || null, comments: opStr(input, "notes") || null,
          delegateId,
        },
        successMessage: `Praticien « ${name} » ajouté à l'annuaire.`,
        link: "/medical", revalidate: ["/medical"],
      };
    },
    execute: (args) => runFd2(createDoctor, args, "La création du praticien a été refusée.", { revalidate: ["/medical"] }),
  },

  update_doctor: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const hit = await resolveDoctor(opStr(input, "doctor") || opStr(input, "name"));
      if ("error" in hit) return hit;
      const d = await prisma.medicalDoctor.findUnique({ where: { id: hit.id } });
      if (!d) return { error: "Praticien introuvable." };
      const title = enumIn(opStr(input, "title"), TITLE_FR);
      if (title && typeof title === "object") return title;
      const sector = enumIn(opStr(input, "sector"), SECTOR_FR);
      if (sector && typeof sector === "object") return sector;
      const influence = enumIn(opStr(input, "influence"), SEGMENT_FR);
      if (influence && typeof influence === "object") return influence;
      const potential = enumIn(opStr(input, "potential"), SEGMENT_FR);
      if (potential && typeof potential === "object") return potential;
      const affinity = enumIn(opStr(input, "affinity"), SEGMENT_FR);
      if (affinity && typeof affinity === "object") return affinity;
      let delegateId = d.delegateId; let delegateChange: string | null = null;
      if (opStr(input, "person")) {
        const delegate = await resolvePerson(opStr(input, "person"), "le délégué (champ « person »)");
        if ("error" in delegate) return delegate;
        delegateId = delegate.id; delegateChange = delegate.name;
      }
      const changes: string[] = [];
      const pick = (key: string, current: string | null, label: string): string | null => {
        const v = opStr(input, key);
        if (v) { changes.push(label); return v; }
        return current;
      };
      const name = pick("newName", d.name, "nom") ?? d.name;
      const specialty = pick("specialty", d.specialty, "spécialité");
      const institution = pick("institution", d.institution, "établissement");
      const wilaya = opStr(input, "wilaya") || opStr(input, "city")
        ? pick(opStr(input, "wilaya") ? "wilaya" : "city", d.wilaya, "wilaya")
        : d.wilaya;
      const region = pick("region", d.region, "région");
      const phone = pick("phone", d.phone, "téléphone");
      const email = pick("email", d.email, "e-mail");
      const targetProducts = pick("products", d.targetProducts, "produits cibles");
      const comments = pick("notes", d.comments, "commentaires");
      if (title && title !== d.title) changes.push("grade");
      if (sector && sector !== d.sector) changes.push("secteur");
      if (influence) changes.push("influence");
      if (potential) changes.push("potentiel");
      if (affinity) changes.push("affinité");
      if (delegateChange) changes.push(`délégué → ${delegateChange}`);
      if (changes.length === 0) return { error: "Rien à changer : donnez newName, title, specialty, sector, institution, city, region, phone, email, influence, potential, affinity, products, notes ou person." };
      return {
        title: `Modifier la fiche de ${d.name}`,
        fields: [
          { label: "Praticien", value: d.name },
          { label: "Modifications", value: changes.join(" · ") },
          { label: "Le reste", value: "rejoué à l'identique (segmentation, entité, délégué compris)" },
        ],
        args: {
          id: hit.id, name, title: (title as string | null) ?? d.title,
          specialty, sector: (sector as string | null) ?? d.sector, institution,
          wilaya, region, phone, email,
          influence: (influence as string | null) ?? d.influence,
          potential: (potential as string | null) ?? d.potential,
          affinity: (affinity as string | null) ?? d.affinity,
          targetProducts, comments, companyId: d.companyId, delegateId,
        },
        successMessage: `Fiche de ${name} mise à jour (${changes.join(", ")}).`,
        link: "/medical", revalidate: ["/medical"],
      };
    },
    execute: (args) => runFd(updateDoctor, args, "La modification du praticien a été refusée.", { revalidate: ["/medical"] }),
  },

  delete_doctor: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const hit = await resolveDoctor(opStr(input, "doctor") || opStr(input, "name"));
      if ("error" in hit) return hit;
      const visits = await prisma.medicalVisit.count({ where: { doctorId: hit.id } });
      return {
        title: `SUPPRIMER le praticien ${hit.name}`,
        fields: [{ label: "Praticien", value: hit.name }, { label: "Visites emportées", value: String(visits) }],
        warnings: [`Suppression définitive de la fiche ET de ses ${visits} visite(s) — il est aussi retiré des listes d'invités de congrès.`],
        confirmText: hit.name,
        args: { id: hit.id },
        successMessage: `Praticien ${hit.name} supprimé (visites comprises).`,
        revalidate: ["/medical"],
      };
    },
    execute: (args) => runFd(deleteDoctor, args, "La suppression du praticien a été refusée.", { revalidate: ["/medical"] }),
  },

  delete_doctors: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const raw = opStr(input, "doctor") || opStr(input, "people");
      if (!raw) return { error: "Précisez les praticiens à supprimer (champ « doctor », noms séparés par des virgules)." };
      const ids: string[] = []; const names: string[] = [];
      for (const part of raw.split(/[;,]/).map((p) => p.trim()).filter(Boolean)) {
        const hit = await resolveDoctor(part);
        if ("error" in hit) return hit;
        ids.push(hit.id); names.push(hit.name);
      }
      return {
        title: `SUPPRIMER ${names.length} fiche(s) de l'annuaire`,
        fields: [{ label: "Praticiens", value: names.join(", ") }],
        warnings: ["Suppression en lot — chaque ligne est revérifiée INDIVIDUELLEMENT : une fiche hors de votre portée est laissée en place, jamais tout ou rien."],
        confirmText: `${names.length} fiches`,
        args: { ids: ids.join(",") },
        successMessage: `${names.length} fiche(s) traitée(s) — le résultat précise les lignes hors portée.`,
        revalidate: ["/medical"],
      };
    },
    async execute(args) {
      const r = await deleteDirectoryDoctors((args.ids ?? "").split(",").filter(Boolean));
      if (!r.ok) return { ok: false, error: r.error ?? "La suppression en lot a été refusée." };
      return { ok: true, message: r.message, revalidate: ["/medical"] };
    },
  },

  // RESTAURER des fiches archivées (le retour de « supprimer », qui archive). On cherche parmi les
  // fiches ARCHIVÉES seulement : restaurer une fiche active n'aurait aucun sens.
  restore_doctors: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const raw = opStr(input, "doctor") || opStr(input, "people");
      if (!raw) return { error: "Précisez les fiches archivées à restaurer (champ « doctor », noms séparés par des virgules)." };
      const ids: string[] = []; const names: string[] = [];
      for (const part of raw.split(/[;,]/).map((p) => p.trim()).filter(Boolean)) {
        const rows = await prisma.medicalDoctor.findMany({
          where: { archivedAt: { not: null }, name: { contains: part, mode: "insensitive" } },
          select: { id: true, name: true }, take: 4,
        });
        if (rows.length === 0) return { error: `Aucune fiche archivée « ${part} ».` };
        if (rows.length > 1) return { error: `Plusieurs fiches archivées correspondent à « ${part} » : ${rows.map((d) => d.name).join(", ")} — préciser.` };
        if (!ids.includes(rows[0].id)) { ids.push(rows[0].id); names.push(rows[0].name); }
      }
      return {
        title: `RESTAURER ${names.length} fiche(s) archivée(s)`,
        fields: [{ label: "Praticiens", value: names.join(", ") }],
        warnings: ["Chaque ligne est revérifiée individuellement : une fiche hors de votre portée reste archivée."],
        args: { ids: ids.join(",") },
        successMessage: `${names.length} fiche(s) traitée(s).`,
        revalidate: ["/medical"],
      };
    },
    async execute(args) {
      const r = await restaurerDirectoryDoctors((args.ids ?? "").split(",").filter(Boolean));
      if (!r.ok) return { ok: false, error: r.error ?? "La restauration a été refusée." };
      return { ok: true, message: r.message, revalidate: ["/medical"] };
    },
  },

  add_doctor_row: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const lastName = opStr(input, "lastName") || opStr(input, "doctor") || opStr(input, "name");
      if (!lastName) return { error: "Précisez au moins le nom (champ « lastName »)." };
      const wilaya = opStr(input, "region");
      return {
        title: `Ajouter la ligne « ${[opStr(input, "firstName"), lastName].filter(Boolean).join(" ")} » à la feuille`,
        fields: fieldsOf([
          ["Nom", lastName], ["Prénom", opStr(input, "firstName") || null],
          ["Spécialité", opStr(input, "specialty") || null], ["Wilaya", wilaya || null],
        ]),
        warnings: ["La fiche naît minimale (feuille de l'annuaire) — le reste se remplit cellule par cellule."],
        args: { lastName, firstName: opStr(input, "firstName") || "", specialty: opStr(input, "specialty") || "", wilaya },
        successMessage: "Ligne ajoutée à l'annuaire.",
        link: "/medical/annuaire", revalidate: ["/medical"],
      };
    },
    async execute(args) {
      const r = await addDirectoryDoctor({
        lastName: args.lastName ?? "", firstName: args.firstName ?? "",
        specialty: args.specialty ?? "", wilaya: args.wilaya ?? "",
      });
      if (!r.ok) return { ok: false, error: r.error ?? "L'ajout de la ligne a été refusé." };
      return { ok: true, revalidate: ["/medical"] };
    },
  },

  set_doctor_cell: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const hit = await resolveDoctor(opStr(input, "doctor") || opStr(input, "name"));
      if ("error" in hit) return hit;
      const field = opStr(input, "field");
      const value = opStr(input, "value");
      if (!field) return { error: "Précisez la colonne (champ « field ») : lastName, firstName, address, wilaya, postalCode, phone, email, title, sector, specialty, potential — ou la clé d'une colonne propre à l'annuaire (« c_… »)." };
      return {
        title: `Cellule « ${field} » de ${hit.name}`,
        fields: [
          { label: "Praticien", value: hit.name },
          { label: "Colonne", value: field },
          { label: "Valeur", value: value || "— (effacée)" },
        ],
        warnings: ["Écriture d'UNE cellule, comme dans la feuille — les menus fermés n'acceptent que leurs options (même validation que l'écran)."],
        args: { id: hit.id, field, value },
        successMessage: `Cellule « ${field} » de ${hit.name} mise à jour.`,
        link: "/medical/annuaire", revalidate: ["/medical"],
      };
    },
    async execute(args) {
      const field = args.field ?? "";
      // Une colonne PROPRE à l'annuaire (« c_dernier_congres ») s'écrit par l'action des colonnes
      // sur mesure, typée par la colonne ; le tronc commun par l'action de la feuille. Même
      // geste pour la personne, deux écrivains parce que deux validations.
      const r = field.startsWith("c_")
        ? await saveDirectoryCustomCell({ id: args.id ?? "", key: field, value: args.value ?? "" })
        : await saveDirectoryCell({ id: args.id ?? "", field, value: args.value ?? "" });
      if (!r.ok) return { ok: false, error: r.error ?? "L'écriture de la cellule a été refusée." };
      return { ok: true, revalidate: ["/medical"] };
    },
  },

  color_directory_cells: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const field = opStr(input, "field");
      if (!field) return { error: "Précisez la colonne à colorer (champ « field ») : wilaya, phone, specialty… ou la clé d'une colonne propre (« c_… ») ; pour un établissement : name, type, sector, wilaya." };
      const brut = fold(opStr(input, "color") || "");
      const effacer = !brut || /^(aucune?|sans|effac|retire|enleve|vide)/.test(brut);
      const couleur = effacer ? null : COULEURS_CELLULE.find((c) => fold(c.cle) === brut || fold(c.label) === brut)?.cle ?? null;
      if (!effacer && !couleur) {
        return { error: `Couleur « ${opStr(input, "color")} » hors palette : ${COULEURS_CELLULE.map((c) => c.label.toLowerCase()).join(", ")} — ou « aucune » pour effacer.` };
      }
      const rawDoctors = opStr(input, "doctor") || opStr(input, "people");
      const rawInstitution = opStr(input, "institution");
      if (!rawDoctors && !rawInstitution) return { error: "Précisez les praticiens (champ « doctor », noms séparés par des virgules) ou l'établissement (champ « institution »)." };

      const ids: string[] = []; const names: string[] = [];
      const feuille: "praticiens" | "etablissements" = rawDoctors ? "praticiens" : "etablissements";
      if (feuille === "praticiens") {
        if (!isAnnuaireField(field) && !field.startsWith("c_")) return { error: `« ${field} » n'est pas une colonne de la feuille des praticiens.` };
        for (const part of rawDoctors.split(/[;,]/).map((p) => p.trim()).filter(Boolean)) {
          const hit = await resolveDoctor(part);
          if ("error" in hit) return hit;
          ids.push(hit.id); names.push(hit.name);
        }
      } else {
        if (!isEtablissementField(field)) return { error: `« ${field} » n'est pas une colonne de la feuille des établissements (name, type, sector, wilaya, doctorCount, sectorCount).` };
        for (const part of rawInstitution.split(/[;,]/).map((p) => p.trim()).filter(Boolean)) {
          const hit = await resolveInstitution(part);
          if ("error" in hit) return hit;
          ids.push(hit.id); names.push(hit.name);
        }
      }
      const libelle = couleur ? COULEURS_CELLULE.find((c) => c.cle === couleur)!.label : "aucune (effacée)";
      return {
        title: couleur ? `Colorer en ${libelle.toLowerCase()} — ${names.length} cellule(s)` : `Effacer la couleur — ${names.length} cellule(s)`,
        fields: [
          { label: feuille === "praticiens" ? "Praticiens" : "Établissements", value: names.join(", ") },
          { label: "Colonne", value: field },
          { label: "Couleur", value: libelle },
        ],
        warnings: ["Une couleur est une annotation PARTAGÉE de la feuille : tous ceux qui la voient la verront. Chaque ligne est revérifiée — une fiche hors de votre portée reste telle quelle."],
        args: { feuille, ids: ids.join(","), field, color: couleur ?? "" },
        successMessage: couleur ? `Cellule(s) colorée(s) en ${libelle.toLowerCase()}.` : "Couleur effacée.",
        link: feuille === "praticiens" ? "/medical/annuaire" : "/annuaires/etablissements", revalidate: ["/medical", "/annuaires"],
      };
    },
    async execute(args) {
      const field = args.field ?? "";
      const cellules = (args.ids ?? "").split(",").filter(Boolean).map((id) => `${id}:${field}`);
      const couleur = args.color && estCouleurCellule(args.color) ? args.color : null;
      const r = await colorerCellulesAnnuaire({
        feuille: args.feuille === "etablissements" ? "etablissements" : "praticiens",
        cellules,
        couleur,
      });
      if (!r.ok) return { ok: false, error: r.error ?? "La coloration a été refusée." };
      return { ok: true, message: r.message, revalidate: ["/medical"] };
    },
  },

  create_visit: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const doctor = await resolveDoctor(opStr(input, "doctor") || opStr(input, "name"));
      if ("error" in doctor) return doctor;
      const status = enumIn(opStr(input, "status"), VISIT_STATUS_FR);
      if (status && typeof status === "object") return status;
      if (status === "COMPLETED") return { error: REFUS_FAITE_PAR_LOG_VISIT };
      let delegateId: string | null = null; let delegateName: string | null = null;
      if (opStr(input, "person")) {
        const delegate = await resolvePerson(opStr(input, "person"), "le délégué (champ « person »)");
        if ("error" in delegate) return delegate;
        delegateId = delegate.id; delegateName = delegate.name;
      }
      return {
        title: `Visite chez ${doctor.name}`,
        fields: fieldsOf([
          ["Praticien", doctor.name],
          ["Date", isoDate(opStr(input, "date")) ?? "aujourd'hui"],
          ["Délégué", delegateName],
          ["Région", opStr(input, "region") || null],
          ["Objectif", opStr(input, "notes") || null],
          ["Produits présentés", opStr(input, "products") || null],
        ]),
        args: {
          doctorId: doctor.id, date: isoDate(opStr(input, "date")), delegateId,
          region: opStr(input, "region") || null, objective: opStr(input, "notes") || null,
          presentedProducts: opStr(input, "products") || null, status: (status as string | null),
        },
        successMessage: `Visite chez ${doctor.name} enregistrée.`,
        link: "/medical", revalidate: ["/medical"],
      };
    },
    execute: (args) => runFd2(createVisit, args, "La création de la visite a été refusée.", { revalidate: ["/medical"] }),
  },

  update_visit: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const visit = await resolveVisit(opStr(input, "doctor") || opStr(input, "name"), opStr(input, "date"));
      if ("error" in visit) return visit;
      const status = enumIn(opStr(input, "status"), VISIT_STATUS_FR);
      if (status && typeof status === "object") return status;
      if (status === "COMPLETED") return { error: REFUS_FAITE_PAR_LOG_VISIT };
      // Reportée ou annulée se dit depuis « Ma journée » (motif, fenêtre de 48 h — §118.193) : l'action le refuse.
      if (status === "POSTPONED" || status === "CANCELLED") {
        return { error: "Une visite se dit reportée ou annulée depuis « Ma journée » : c'est là que s'appliquent le motif et la fenêtre de 48 h." };
      }
      // L'action n'écrit QUE les champs soumis : rien à rejouer, on n'envoie que le demandé.
      const updates = fieldsOf([
        ["Statut", status ? VISIT_STATUS_FR.find(([c]) => c === status)?.[1] ?? null : null],
        ["Compte rendu", opStr(input, "report") || null],
        ["Retour du médecin", opStr(input, "feedback") || null],
        ["Actions de suivi", opStr(input, "followUp") || null],
        ["Objectif", opStr(input, "notes") || null],
        ["Produits présentés", opStr(input, "products") || null],
      ]);
      if (updates.length === 0) return { error: "Rien à changer : donnez report, feedback, followUp, notes ou products." };
      return {
        title: `Visite chez ${visit.doctorName} du ${day(visit.date)}`,
        fields: [{ label: "Visite", value: `${visit.doctorName} — ${day(visit.date)}` }, ...updates],
        args: {
          id: visit.id, status: (status as string | null),
          report: opStr(input, "report") || null, doctorFeedback: opStr(input, "feedback") || null,
          followUpActions: opStr(input, "followUp") || null, objective: opStr(input, "notes") || null,
          presentedProducts: opStr(input, "products") || null,
        },
        successMessage: `Visite chez ${visit.doctorName} mise à jour.`,
        revalidate: ["/medical"],
      };
    },
    execute: (args) => runFd(updateVisit, args, "La mise à jour de la visite a été refusée.", { revalidate: ["/medical"] }),
  },

  delete_visit: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const visit = await resolveVisit(opStr(input, "doctor") || opStr(input, "name"), opStr(input, "date"));
      if ("error" in visit) return visit;
      return {
        title: `Supprimer la visite chez ${visit.doctorName} du ${day(visit.date)}`,
        fields: [{ label: "Visite", value: `${visit.doctorName} — ${day(visit.date)}` }],
        warnings: ["Suppression définitive de la visite (le délégué auteur, ou le droit Supprimer sur l'Annuaire)."],
        args: { id: visit.id },
        successMessage: "Visite supprimée.",
        revalidate: ["/medical"],
      };
    },
    execute: (args) => runFd(deleteVisit, args, "La suppression de la visite a été refusée.", { revalidate: ["/medical"] }),
  },

  delete_institution: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const inst = await resolveInstitution(opStr(input, "institution") || opStr(input, "name"));
      if ("error" in inst) return inst;
      const doctors = await prisma.medicalDoctor.count({ where: { institutionId: inst.id } });
      return {
        title: `Supprimer l'établissement « ${inst.name} »`,
        fields: [{ label: "Établissement", value: inst.name }, { label: "Praticiens rattachés", value: String(doctors) }],
        warnings: ["Les praticiens rattachés passent « Sans établissement » — AUCUNE fiche n'est supprimée."],
        args: { id: inst.id },
        successMessage: `Établissement « ${inst.name} » supprimé (praticiens conservés).`,
        revalidate: ["/medical"],
      };
    },
    execute: (args) => runFd(deleteInstitution, args, "La suppression de l'établissement a été refusée.", { revalidate: ["/medical"] }),
  },

  create_specialty: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const name = opStr(input, "specialty") || opStr(input, "name");
      if (!name) return { error: "Précisez le nom de la spécialité (champ « specialty »)." };
      return {
        title: `Nouvelle spécialité « ${name} »`,
        fields: fieldsOf([["Spécialité", name], ["Couleur", opStr(input, "color") || null], ["Notes", opStr(input, "notes") || null]]),
        args: { name, color: opStr(input, "color") || null, notes: opStr(input, "notes") || null },
        successMessage: `Spécialité « ${name} » créée.`,
        revalidate: ["/medical"],
      };
    },
    execute: (args) => runFd(createSpecialty, args, "La création de la spécialité a été refusée.", { revalidate: ["/medical"] }),
  },

  update_specialty: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const spec = await resolveSpecialty(opStr(input, "specialty") || opStr(input, "name"));
      if ("error" in spec) return spec;
      const current = await prisma.medicalSpecialty.findUnique({ where: { id: spec.id }, select: { color: true, notes: true } });
      const newName = opStr(input, "newName") || spec.name;
      // FUSION : l'action REMPLACE couleur et notes — l'existant est rejoué si non fourni.
      return {
        title: `Modifier la spécialité « ${spec.name} »`,
        fields: fieldsOf([
          ["Spécialité", newName !== spec.name ? `${spec.name} → ${newName}` : spec.name],
          ["Couleur", opStr(input, "color") || current?.color || null],
        ]),
        warnings: ["Le libellé dénormalisé est resynchronisé sur TOUS les praticiens de la spécialité."],
        args: { id: spec.id, name: newName, color: opStr(input, "color") || current?.color || null, notes: opStr(input, "notes") || current?.notes || null },
        successMessage: `Spécialité « ${newName} » mise à jour.`,
        revalidate: ["/medical"],
      };
    },
    execute: (args) => runFd(updateSpecialty, args, "La modification de la spécialité a été refusée.", { revalidate: ["/medical"] }),
  },

  delete_specialty: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const spec = await resolveSpecialty(opStr(input, "specialty") || opStr(input, "name"));
      if ("error" in spec) return spec;
      const doctors = await prisma.medicalDoctor.count({ where: { specialtyId: spec.id } });
      return {
        title: `Supprimer la spécialité « ${spec.name} »`,
        fields: [{ label: "Spécialité", value: spec.name }, { label: "Praticiens concernés", value: String(doctors) }],
        warnings: ["Les praticiens passent « Sans spécialité » — AUCUNE fiche n'est supprimée."],
        args: { id: spec.id },
        successMessage: `Spécialité « ${spec.name} » supprimée (praticiens conservés).`,
        revalidate: ["/medical"],
      };
    },
    execute: (args) => runFd(deleteSpecialty, args, "La suppression de la spécialité a été refusée.", { revalidate: ["/medical"] }),
  },
};
