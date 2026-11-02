/**
 * OPS VAGUE 4b — ANNUAIRE MÉDICAL, seconde famille : annuaires nommés, leurs colonnes propres,
 * le déplacement de praticiens d'un annuaire à l'autre, les accès désignés et les plans de tournée.
 */
import { prisma } from "./erp";
import { createMedicalDirectory, updateMedicalDirectory, deleteMedicalDirectory, moveDoctorsToDirectory, setDirectoryAccess, createDirectoryColumn, updateDirectoryColumn, deleteDirectoryColumn } from "@/lib/actions/medical-directory-crud-actions";
import { createDelegatePlan, updateDelegatePlan, deleteDelegatePlan, duplicateDelegatePlan } from "@/lib/actions/delegate-plan-actions";
import type { OpImpl, OpProposalDraft } from "../../types";
import { opStr } from "../../types";
import { runFd, runFd2, fieldsOf, resolveOne, isoDate } from "../../helpers";
import { day, resolvePerson, resolveDoctor } from "./commun";

const resolveDirectory = (raw: string) =>
  resolveOne(raw, "l'annuaire (champ « directory »)",
    (q) => prisma.medicalDirectory.findMany({ where: { name: { contains: q, mode: "insensitive" } }, select: { id: true, name: true }, take: 6 }),
    (d) => d.name);

/**
 * UNE COLONNE PROPRE À UN ANNUAIRE, retrouvée par son libellé.
 *
 * L'annuaire est demandé D'ABORD : deux annuaires peuvent avoir une colonne « Statut », et
 * modifier celle du mauvais annuaire ne produit aucune erreur — juste une grille fausse ailleurs.
 */
async function resolveDirectoryColumn(directoryRaw: string, columnRaw: string) {
  const dir = await resolveDirectory(directoryRaw);
  if ("error" in dir) return dir;
  if (!columnRaw) return { error: "Précisez la colonne (champ « column »)." };
  const found = await prisma.medicalDirectoryColumn.findMany({
    where: { directoryId: dir.id, label: { contains: columnRaw, mode: "insensitive" } },
    select: { id: true, label: true }, take: 6,
  });
  if (found.length === 0) return { error: `Aucune colonne « ${columnRaw} » dans l'annuaire « ${dir.name} ».` };
  if (found.length > 1) {
    return { error: `Plusieurs colonnes correspondent à « ${columnRaw} » : ${found.map((c) => c.label).join(", ")}. Précisez.` };
  }
  return { id: found[0].id, label: found[0].label, directoryName: dir.name };
}

interface PlanHit { id: string; label: string }

async function resolvePlan(raw: string, dateRaw: string): Promise<PlanHit | { error: string }> {
  const date = isoDate(dateRaw);
  const person = raw ? await resolvePerson(raw, "le délégué (champ « person »)") : null;
  if (person && "error" in person) return person;
  const rows = await prisma.medicalDelegatePlan.findMany({
    where: {
      ...(person ? { delegateId: person.id } : {}),
      ...(date ? { weekStart: { gte: new Date(`${date}T00:00:00Z`), lt: new Date(new Date(`${date}T00:00:00Z`).getTime() + 86_400_000) } } : {}),
    },
    select: { id: true, weekStart: true, region: true, delegate: { select: { name: true } } },
    orderBy: { weekStart: "desc" }, take: 6,
  });
  const label = (p: (typeof rows)[number]) => `${day(p.weekStart)} — ${p.delegate?.name ?? "sans délégué"}${p.region ? ` (${p.region})` : ""}`;
  if (rows.length === 0) return { error: `Aucun plan de tournée${person ? ` pour ${person.name}` : ""}${date ? ` au ${date}` : ""}.` };
  if (rows.length > 1) return { error: `Plusieurs plans correspondent : ${rows.map(label).join(" ; ")} — préciser la date de début (champ « date ») et/ou le délégué.` };
  return { id: rows[0].id, label: label(rows[0]) };
}

export const MEDICAL_ANNUAIRES_OPS_IMPL: Record<string, OpImpl> = {
  create_directory: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const name = opStr(input, "directory") || opStr(input, "name");
      if (!name) return { error: "Précisez le nom de l'annuaire (champ « directory »)." };
      return {
        title: `Créer l'annuaire « ${name} »`,
        fields: fieldsOf([["Annuaire", name], ["Description", opStr(input, "notes") || null]]),
        warnings: ["Un annuaire RANGE, il n'autorise pas : le cloisonnement par entité et la portée du délégué restent les seules règles d'accès."],
        args: { name, description: opStr(input, "notes") || null },
        successMessage: `Annuaire « ${name} » créé.`,
        link: "/medical/annuaire", revalidate: ["/medical"],
      };
    },
    execute: (args) => runFd2(createMedicalDirectory, args, "La création de l'annuaire a été refusée.", { revalidate: ["/medical"] }),
  },

  update_directory: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const dir = await resolveDirectory(opStr(input, "directory") || opStr(input, "name"));
      if ("error" in dir) return dir;
      const newName = opStr(input, "newName");
      const description = opStr(input, "notes");
      if (!newName && !description) return { error: "Rien à changer : donnez newName et/ou notes (description)." };
      return {
        title: `Modifier l'annuaire « ${dir.name} »`,
        fields: fieldsOf([
          ["Annuaire", newName ? `${dir.name} → ${newName}` : dir.name],
          ["Description", description || null],
        ]),
        args: { id: dir.id, name: newName || null, ...(description ? { description } : {}) },
        successMessage: `Annuaire « ${newName || dir.name} » mis à jour.`,
        revalidate: ["/medical"],
      };
    },
    execute: (args) => runFd(updateMedicalDirectory, args, "La modification de l'annuaire a été refusée.", { revalidate: ["/medical"] }),
  },

  delete_directory: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const dir = await resolveDirectory(opStr(input, "directory") || opStr(input, "name"));
      if ("error" in dir) return dir;
      const count = await prisma.medicalDoctor.count({ where: { directoryId: dir.id } });
      return {
        title: `Supprimer l'annuaire « ${dir.name} »`,
        fields: [{ label: "Annuaire", value: dir.name }, { label: "Praticiens rangés dedans", value: String(count) }],
        warnings: [`Les ${count} praticien(s) repassent dans l'annuaire général — AUCUNE fiche n'est supprimée.`],
        args: { id: dir.id },
        successMessage: `Annuaire « ${dir.name} » supprimé (praticiens rendus au général).`,
        revalidate: ["/medical"],
      };
    },
    execute: (args) => runFd(deleteMedicalDirectory, args, "La suppression de l'annuaire a été refusée.", { revalidate: ["/medical"] }),
  },

  // ── LES COLONNES PROPRES À UN ANNUAIRE ────────────────────────────────────────────────
  // Le tronc commun ne prévoit pas « Dernier congrès » ni « Numéro d'officine ». Les ajouter au
  // tronc les imposerait à TOUS les annuaires ; ces trois gestes les tiennent annuaire par
  // annuaire. La valeur vit dans `MedicalDoctor.custom` — aucune migration pour un champ de plus.

  create_directory_column: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const dir = await resolveDirectory(opStr(input, "directory"));
      if ("error" in dir) return dir;
      const label = opStr(input, "label") || opStr(input, "name");
      if (!label) return { error: "Précisez le nom de la colonne (champ « label »)." };
      const kindRaw = (opStr(input, "kind") || "TEXT").toUpperCase();
      const kind = ["TEXT", "NUMBER", "DATE", "CHOICE"].includes(kindRaw) ? kindRaw : "TEXT";
      const options = opStr(input, "options");
      if (kind === "CHOICE" && !options) {
        return { error: "Une colonne à choix a besoin de ses options (champ « options », séparées par |)." };
      }
      return {
        title: `Ajouter la colonne « ${label} » à l'annuaire « ${dir.name} »`,
        fields: fieldsOf([
          ["Annuaire", dir.name], ["Colonne", label], ["Type", kind],
          ["Options", kind === "CHOICE" ? options : null],
        ]),
        warnings: ["La colonne n'existe que dans CET annuaire — les autres ne la voient pas."],
        args: { directoryId: dir.id, label, kind, ...(options ? { options } : {}) },
        successMessage: `Colonne « ${label} » ajoutée.`,
        link: "/medical/annuaire", revalidate: ["/medical"],
      };
    },
    execute: (args) => runFd(createDirectoryColumn, args, "L'ajout de la colonne a été refusé.", { revalidate: ["/medical"] }),
  },

  update_directory_column: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const col = await resolveDirectoryColumn(opStr(input, "directory"), opStr(input, "column") || opStr(input, "label"));
      if ("error" in col) return col;
      const newLabel = opStr(input, "newName") || opStr(input, "newLabel");
      const kindRaw = opStr(input, "kind").toUpperCase();
      const kind = ["TEXT", "NUMBER", "DATE", "CHOICE"].includes(kindRaw) ? kindRaw : "";
      const options = opStr(input, "options");
      if (!newLabel && !kind && !options) return { error: "Rien à changer : donnez newName, kind et/ou options." };
      return {
        title: `Modifier la colonne « ${col.label} »`,
        fields: fieldsOf([
          ["Annuaire", col.directoryName],
          ["Colonne", newLabel ? `${col.label} → ${newLabel}` : col.label],
          ["Type", kind || null], ["Options", options || null],
        ]),
        warnings: ["Renommer NE PERD PAS les valeurs déjà saisies : la clé technique reste la même."],
        args: { id: col.id, ...(newLabel ? { label: newLabel } : {}), ...(kind ? { kind } : {}), ...(options ? { options } : {}) },
        successMessage: `Colonne « ${newLabel || col.label} » modifiée.`,
        revalidate: ["/medical"],
      };
    },
    execute: (args) => runFd(updateDirectoryColumn, args, "La modification de la colonne a été refusée.", { revalidate: ["/medical"] }),
  },

  delete_directory_column: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const col = await resolveDirectoryColumn(opStr(input, "directory"), opStr(input, "column") || opStr(input, "label"));
      if ("error" in col) return col;
      return {
        title: `Retirer la colonne « ${col.label} » de l'annuaire « ${col.directoryName} »`,
        fields: [{ label: "Annuaire", value: col.directoryName }, { label: "Colonne", value: col.label }],
        warnings: [
          "La colonne disparaît de la grille. LES VALEURS DÉJÀ SAISIES SONT CONSERVÉES : recréer "
          + "la colonne sous le même nom les retrouve.",
        ],
        args: { id: col.id },
        successMessage: `Colonne « ${col.label} » retirée (valeurs conservées).`,
        revalidate: ["/medical"],
      };
    },
    execute: (args) => runFd(deleteDirectoryColumn, args, "Le retrait de la colonne a été refusé.", { revalidate: ["/medical"] }),
  },

  move_doctors_to_directory: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const raw = opStr(input, "doctor") || opStr(input, "people");
      if (!raw) return { error: "Précisez les praticiens (champ « doctor », noms séparés par des virgules)." };
      const ids: string[] = []; const names: string[] = [];
      for (const part of raw.split(/[;,]/).map((p) => p.trim()).filter(Boolean)) {
        const hit = await resolveDoctor(part);
        if ("error" in hit) return hit;
        ids.push(hit.id); names.push(hit.name);
      }
      const dirRaw = opStr(input, "directory");
      const toGeneral = /^(g[ée]n[ée]ral|aucun|sortir)/i.test(dirRaw);
      let directoryId: string | null = null; let dirName = "Annuaire général";
      if (!toGeneral) {
        if (!dirRaw) return { error: "Précisez l'annuaire de destination (champ « directory » — « général » pour les en sortir)." };
        const dir = await resolveDirectory(dirRaw);
        if ("error" in dir) return dir;
        directoryId = dir.id; dirName = dir.name;
      }
      return {
        title: `Ranger ${names.length} praticien(s) dans « ${dirName} »`,
        fields: [{ label: "Praticiens", value: names.join(", ") }, { label: "Destination", value: dirName }],
        warnings: ["Ranger n'ouvre l'accès à personne — seules les fiches de votre périmètre bougent."],
        args: { doctorIds: ids.join(","), directoryId },
        successMessage: `${names.length} praticien(s) rangé(s) dans « ${dirName} ».`,
        revalidate: ["/medical"],
      };
    },
    async execute(args) {
      const fd = new FormData();
      for (const id of (args.doctorIds ?? "").split(",").filter(Boolean)) fd.append("doctorId", id);
      if (args.directoryId) fd.set("directoryId", args.directoryId);
      const r = await moveDoctorsToDirectory(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "Le rangement a été refusé." };
      return { ok: true, message: r.message, revalidate: ["/medical"] };
    },
  },

  set_directory_access: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const dir = await resolveDirectory(opStr(input, "directory") || opStr(input, "name"));
      if ("error" in dir) return dir;
      const raw = opStr(input, "people");
      const opening = /^(tous|tout le monde|ouvre|aucune?)/i.test(raw);
      const ids: string[] = []; const names: string[] = [];
      if (!opening && raw) {
        for (const part of raw.split(/[;,]/).map((p) => p.trim()).filter(Boolean)) {
          const person = await resolvePerson(part, "la personne (champ « people »)");
          if ("error" in person) return person;
          ids.push(person.id); names.push(person.name);
        }
      }
      if (!opening && ids.length === 0) return { error: "Donnez les personnes (champ « people », virgules) — ou « tous » pour lever la restriction." };
      return {
        title: opening ? `Ouvrir l'annuaire « ${dir.name} » à tout le module` : `Restreindre « ${dir.name} » à ${names.length} personne(s)`,
        fields: [
          { label: "Annuaire", value: dir.name },
          { label: "Accès", value: opening ? "Ouvert à tout le module (restriction levée)" : names.join(", ") },
        ],
        warnings: opening ? [] : ["La liste REMPLACE la précédente — celui qui restreint se garde sa propre porte (ajouté d'office)."],
        args: { id: dir.id, userIds: ids.join(",") },
        successMessage: opening ? `Annuaire « ${dir.name} » ouvert à tout le module.` : `Accès de « ${dir.name} » réglé (${names.length} personne(s)).`,
        revalidate: ["/medical"],
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("id", args.id ?? "");
      for (const id of (args.userIds ?? "").split(",").filter(Boolean)) fd.append("userId", id);
      const r = await setDirectoryAccess(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "Le réglage de l'accès a été refusé." };
      return { ok: true, message: r.message, revalidate: ["/medical"] };
    },
  },

  create_plan: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const weekStart = isoDate(opStr(input, "date"));
      if (!weekStart) return { error: "Précisez la date de début de période (champ « date », AAAA-MM-JJ)." };
      let delegateId: string | null = null; let delegateName: string | null = null;
      if (opStr(input, "person")) {
        const delegate = await resolvePerson(opStr(input, "person"), "le délégué (champ « person »)");
        if ("error" in delegate) return delegate;
        delegateId = delegate.id; delegateName = delegate.name;
      }
      return {
        title: `Plan de tournée${delegateName ? ` — ${delegateName}` : ""} (début ${weekStart})`,
        fields: fieldsOf([
          ["Délégué", delegateName ?? "moi-même"],
          ["Début de période", weekStart],
          ["Région", opStr(input, "region") || null],
          ["Produit cible", opStr(input, "products") || null],
          ["Visites cibles", opStr(input, "quantity") || null],
          ["Médecins clés cibles", opStr(input, "keyTargets") || null],
        ]),
        args: {
          weekStart, delegateId, region: opStr(input, "region") || null,
          productTarget: opStr(input, "products") || null,
          visitsTarget: opStr(input, "quantity") || null,
          keyDoctorsTarget: opStr(input, "keyTargets") || null,
          managerComment: opStr(input, "notes") || null,
        },
        successMessage: `Plan de tournée créé (début ${weekStart}).`,
        link: "/medical", revalidate: ["/medical"],
      };
    },
    execute: (args) => runFd(createDelegatePlan, args, "La création du plan a été refusée.", { revalidate: ["/medical"] }),
  },

  update_plan: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const plan = await resolvePlan(opStr(input, "person"), opStr(input, "date"));
      if ("error" in plan) return plan;
      const p = await prisma.medicalDelegatePlan.findUnique({ where: { id: plan.id } });
      if (!p) return { error: "Plan introuvable." };
      // FUSION : l'action REMPLACE région / produit / cibles (absentes → 0) — tout est rejoué.
      const changes: string[] = [];
      const region = opStr(input, "region") ? (changes.push("région"), opStr(input, "region")) : p.region;
      const productTarget = opStr(input, "products") ? (changes.push("produit cible"), opStr(input, "products")) : p.productTarget;
      const visitsTarget = opStr(input, "quantity") ? (changes.push("visites cibles"), opStr(input, "quantity")) : String(p.visitsTarget);
      const keyDoctorsTarget = opStr(input, "keyTargets") ? (changes.push("médecins clés"), opStr(input, "keyTargets")) : String(p.keyDoctorsTarget);
      const achievedVisits = opStr(input, "achieved") ? (changes.push("visites réalisées"), opStr(input, "achieved")) : null;
      const managerComment = opStr(input, "notes") ? (changes.push("commentaire manager"), opStr(input, "notes")) : p.managerComment;
      if (changes.length === 0) return { error: "Rien à changer : donnez region, products, quantity (visites cibles), keyTargets, achieved ou notes." };
      return {
        title: `Modifier le plan ${plan.label}`,
        fields: [
          { label: "Plan", value: plan.label },
          { label: "Modifications", value: changes.join(" · ") },
          { label: "Le reste", value: "rejoué à l'identique" },
        ],
        args: { id: plan.id, region, productTarget, visitsTarget, keyDoctorsTarget, achievedVisits, managerComment },
        successMessage: `Plan ${plan.label} mis à jour (${changes.join(", ")}).`,
        revalidate: ["/medical"],
      };
    },
    execute: (args) => runFd(updateDelegatePlan, args, "La modification du plan a été refusée.", { revalidate: ["/medical"] }),
  },

  delete_plan: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const plan = await resolvePlan(opStr(input, "person"), opStr(input, "date"));
      if ("error" in plan) return plan;
      return {
        title: `Supprimer le plan ${plan.label}`,
        fields: [{ label: "Plan", value: plan.label }],
        warnings: ["Suppression définitive du plan de tournée (propriétaire ou manager)."],
        args: { id: plan.id },
        successMessage: `Plan ${plan.label} supprimé.`,
        revalidate: ["/medical"],
      };
    },
    execute: (args) => runFd(deleteDelegatePlan, args, "La suppression du plan a été refusée.", { revalidate: ["/medical"] }),
  },

  duplicate_plan: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const plan = await resolvePlan(opStr(input, "person"), opStr(input, "date"));
      if ("error" in plan) return plan;
      const newStart = isoDate(opStr(input, "newDate"));
      return {
        title: `Dupliquer le plan ${plan.label}`,
        fields: [
          { label: "Plan source", value: plan.label },
          { label: "Nouvelle période", value: newStart ?? "le mois suivant (défaut)" },
        ],
        warnings: ["Région, cibles et produit sont repris — l'avancement repart à zéro."],
        args: { id: plan.id, weekStart: newStart },
        successMessage: `Plan dupliqué${newStart ? ` (début ${newStart})` : " sur le mois suivant"}.`,
        revalidate: ["/medical"],
      };
    },
    execute: (args) => runFd(duplicateDelegatePlan, args, "La duplication du plan a été refusée.", { revalidate: ["/medical"] }),
  },
};
