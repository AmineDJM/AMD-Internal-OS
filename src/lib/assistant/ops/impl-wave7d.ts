import { prisma } from "@/lib/prisma";
import { masquerSensibles } from "@/platform/in-process/capacites";
import type { EntityType } from "@prisma/client";
import { updateCompany, setCompanyScope } from "@/lib/actions/company-actions";
import { updateCompanyContact, deleteCompanyContact } from "@/lib/actions/company-contact-actions";
import { updateDepartment, deleteDepartment } from "@/lib/actions/department-actions";
import { saveOrgNode } from "@/lib/actions/org-actions";
import { setCompanyAccess } from "@/lib/actions/company-access-actions";
import { toggleSupplierUser } from "@/lib/actions/supplier-actions";
import { submitFeedback, updateFeedbackStatus } from "@/lib/actions/feedback-actions";
import { attachOrphansToCompany } from "@/lib/actions/entity-attach-actions";
import { setPipelineAccess } from "@/lib/actions/settings-actions";
import { setRowGrants } from "@/lib/actions/access-actions";
import { updateAiSettings } from "@/lib/actions/ai-settings-actions";
import { setFeatureStage } from "@/lib/actions/feature-actions";
import { updateRiskThresholds } from "@/lib/actions/adventum-actions";
import { purgeOrphanStorage, permanentlyDeleteDriveNode, permanentlyDeleteDocument } from "@/lib/actions/database-admin-actions";
import { saveCompanyIdentity } from "@/lib/actions/company-identity-actions";
import { saveCustomValues } from "@/lib/actions/custom-field-actions";
import { deleteOwnRecord } from "@/lib/actions/admin-delete-actions";
import { THRESHOLD_FIELDS, DEFAULT_THRESHOLDS } from "@/lib/adventum/risk-settings";
import { IDENTITY_SECTIONS, identityFieldKeys } from "@/lib/legal/identity";
import { getMyCompanies } from "@/lib/company";
import { getFieldDefs, readCustomValues, CUSTOM_ENTITY_TYPES } from "@/lib/custom-fields";
import { isDeletableKind, type DeletableKind } from "@/lib/admin-delete-registry";
import { resolveDeletableTarget } from "../delete-resolve";
import { ENTITY_TYPE_LABELS, ROLE_LABELS } from "@/lib/labels";
import type { CurrentUser } from "@/lib/session";
import type { OpImpl, OpProposalDraft } from "./types";
import { opStr } from "./types";
import { runFd, runFd2, fieldsOf } from "./helpers";
import { matchLabel, fold } from "./impl-regulatory";

/**
 * OPS VAGUE 7d — L'ADMINISTRATION PROFONDE, dernière vague de parité hors fichiers : entités
 * (fiche en FUSION, portée du sélecteur), annuaire d'entreprise (FUSION, retrait), départements
 * (FUSION anti-cycle, suppression au remontage), organigramme (N+1), accès aux entités,
 * comptes portail fournisseur, feedback (dépôt + traitement), rattachement des orphelins,
 * accès pipeline & lignes accordées (FUSION de listes), Centre de contrôle IA (FUSION),
 * nouveautés TEST→PROD, seuils du Risk Radar (FUSION), purge de stockage et suppressions
 * DÉFINITIVES (CRITIQUES), carte d'identité légale (FUSION), champs personnalisés (FUSION),
 * suppression par le créateur. Par les ACTIONS CANONIQUES — qui revalident tout.
 */

// ─────────────────────────── résolutions partagées ───────────────────────────

interface CompanyHit { id: string; name: string }

async function resolveCompany(raw: string): Promise<CompanyHit | { error: string }> {
  const q = raw.trim();
  if (!q) return { error: "Nommez l'entité (champ « name » ou « company »)." };
  const rows = await prisma.company.findMany({
    where: { name: { contains: q, mode: "insensitive" } },
    select: { id: true, name: true }, take: 6,
  });
  if (rows.length === 1) return rows[0];
  if (rows.length === 0) return { error: `Aucune entité « ${q} ».` };
  const exact = rows.find((c) => fold(c.name) === fold(q));
  if (exact) return exact;
  return { error: `Plusieurs entités correspondent à « ${q} » : ${rows.map((c) => c.name).join(", ")} — préciser.` };
}

async function resolveAccount(raw: string): Promise<{ id: string; name: string } | { error: string }> {
  const q = raw.trim();
  if (!q) return { error: "Nommez la personne (champ « person »)." };
  const rows = await prisma.user.findMany({
    where: { name: { contains: q, mode: "insensitive" }, isActive: true },
    select: { id: true, name: true }, take: 6,
  });
  if (rows.length === 1) return rows[0];
  if (rows.length === 0) return { error: `Aucun compte actif « ${q} ».` };
  return { error: `Plusieurs comptes correspondent à « ${q} » : ${rows.map((u) => u.name).join(", ")} — préciser.` };
}

async function resolveEmployee(raw: string): Promise<{ id: string; fullName: string } | { error: string }> {
  const q = raw.trim();
  if (!q) return { error: "Nommez l'employé (registre RH)." };
  const rows = await prisma.employee.findMany({
    where: { fullName: { contains: q, mode: "insensitive" } },
    select: { id: true, fullName: true }, take: 6,
  });
  if (rows.length === 1) return rows[0];
  if (rows.length === 0) return { error: `Aucun employé « ${q} » au registre RH.` };
  const exact = rows.find((e) => fold(e.fullName) === fold(q));
  if (exact) return exact;
  return { error: `Plusieurs employés correspondent à « ${q} » : ${rows.map((e) => e.fullName).join(", ")} — préciser.` };
}

async function resolveDepartment(raw: string): Promise<{ id: string; name: string; parentId: string | null; companyId: string | null; description: string | null; headId: string | null; deputyId: string | null } | { error: string }> {
  const q = raw.trim();
  if (!q) return { error: "Nommez le département (champ « department »)." };
  const rows = await prisma.department.findMany({
    where: { name: { contains: q, mode: "insensitive" } },
    select: { id: true, name: true, parentId: true, companyId: true, description: true, headId: true, deputyId: true },
    take: 6,
  });
  if (rows.length === 1) return rows[0];
  if (rows.length === 0) return { error: `Aucun département « ${q} ».` };
  const exact = rows.filter((d) => fold(d.name) === fold(q));
  if (exact.length === 1) return exact[0];
  return { error: `Plusieurs départements correspondent à « ${q} » : ${rows.map((d) => d.name).join(", ")} — préciser (le nom est unique PAR entité).` };
}

const ROLE_PAIRS_7D: [string, string][] = Object.entries(ROLE_LABELS as Record<string, string>);
const ENTITY_PAIRS_7D: [string, string][] = Object.entries(ENTITY_TYPE_LABELS as Record<string, string>);

/** Une cible d'un type quelconque : par NOM via le registre de suppression, sinon par id interne.
 *  (Exportée : la vague 8 « fichiers » résout les objets de rattachement par le même chemin.) */
export async function resolveRecordOfType(entityType: string, raw: string): Promise<{ id: string; name: string } | { error: string }> {
  const q = raw.trim();
  if (!q) return { error: "Désignez l'enregistrement visé (champ « record » : référence, nom ou id interne)." };
  if (isDeletableKind(entityType)) {
    const hit = await resolveDeletableTarget(entityType, q);
    if (hit.status === "resolved") return { id: hit.id, name: hit.name };
    if (hit.status === "ambiguous") {
      return { error: `Plusieurs enregistrements correspondent à « ${q} » : ${hit.candidates.map((c) => c.name).join(" ; ")} — préciser.` };
    }
    return { error: `Aucun enregistrement « ${q} » de ce type.` };
  }
  return { error: `Le type « ${ENTITY_TYPE_LABELS[entityType as keyof typeof ENTITY_TYPE_LABELS] ?? entityType} » ne se résout pas par nom ici — donnez l'id interne (copié du lien de la fiche).` };
}

const onOff = (b: boolean): string => (b ? "on" : "off");

// ─────────────────────────── ORG (Administration) ───────────────────────────

export const ORG7D_OPS_IMPL: Record<string, OpImpl> = {
  update_company: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const c = await resolveCompany(opStr(input, "name") || opStr(input, "company"));
      if ("error" in c) return c;
      const row = await prisma.company.findUnique({
        where: { id: c.id }, select: { name: true, shortName: true, color: true, isActive: true },
      });
      if (!row) return { error: "Entité introuvable." };
      const newName = opStr(input, "newName") || row.name;
      const shortName = opStr(input, "shortName") || row.shortName || "";
      const color = opStr(input, "color") || row.color || "";
      const activeRaw = opStr(input, "active");
      const isActive = activeRaw ? !/^(inactif|inactive|non|off|d[ée]sactiv)/.test(fold(activeRaw)) : row.isActive;
      return {
        title: `Modifier l'entité « ${row.name} »`,
        fields: fieldsOf([
          ["Nom", newName !== row.name ? `${row.name} → ${newName}` : row.name],
          ["Nom court", shortName || "—"],
          ["Couleur", color || "—"],
          ["Active", isActive ? "oui" : "NON (disparaît du sélecteur)"],
        ]),
        warnings: ["Fiche REMPLACÉE par l'action : les champs non cités sont rejoués à l'identique (FUSION)."],
        args: { id: c.id, name: newName, shortName: shortName || null, color: color || null, isActive: onOff(isActive) },
        successMessage: `Entité « ${newName} » modifiée.`,
      };
    },
    execute: (args) => runFd(updateCompany, args, "Modification refusée."),
  },

  set_company_scope: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const raw = opStr(input, "name") || opStr(input, "company") || opStr(input, "value");
      const mine = await getMyCompanies(user.id);
      if (mine.length === 0) return { error: "Aucune entité dans votre périmètre." };
      let value = "ALL"; let shown = "toutes mes entités";
      if (raw && !/^tout/.test(fold(raw))) {
        const hit = mine.find((c) => fold(c.name).includes(fold(raw)) || fold(raw).includes(fold(c.name)));
        if (!hit) return { error: `« ${raw} » n'est pas dans votre périmètre. Vos entités : ${mine.map((c) => c.name).join(", ")} (ou « toutes »).` };
        value = hit.id; shown = hit.name;
      }
      return {
        title: "Changer la portée d'entité (sélecteur)",
        fields: fieldsOf([["Portée", shown]]),
        warnings: ["Réglage personnel du SÉLECTEUR (cookie) — une entité hors droit retomberait sur votre portée légitime."],
        args: { value },
        successMessage: `Portée d'entité : ${shown}.`,
      };
    },
    async execute(args) {
      await setCompanyScope(args.value ?? "ALL");
      return { ok: true, message: "Portée d'entité mise à jour.", revalidate: ["/"] };
    },
  },

  update_company_contact: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const q = opStr(input, "name");
      if (!q) return { error: "Nommez le contact de l'annuaire d'entreprise (champ « name »)." };
      const rows = await prisma.companyContact.findMany({
        where: { name: { contains: q, mode: "insensitive" } },
        take: 6,
      });
      if (rows.length === 0) return { error: `Aucun contact « ${q} » à l'annuaire d'entreprise.` };
      if (rows.length > 1 && !rows.some((r) => fold(r.name) === fold(q))) {
        return { error: `Plusieurs contacts correspondent à « ${q} » : ${rows.map((r) => r.name).join(", ")} — préciser.` };
      }
      const row = rows.find((r) => fold(r.name) === fold(q)) ?? rows[0];
      const pick = (key: string, cur: string | null): string => opStr(input, key) || cur || "";
      const name = opStr(input, "newName") || row.name;
      const next = {
        kind: pick("kind", row.kind), contactName: pick("contactName", row.contactName),
        phone: pick("phone", row.phone), phoneAlt: row.phoneAlt ?? "", email: pick("email", row.email),
        website: pick("website", row.website), address: pick("address", row.address), city: pick("city", row.city),
        // Le RIB part MASQUÉ (refonte V2-E) : rejoué, le masque garde la valeur en place.
        wilaya: pick("wilaya", row.wilaya), rc: row.rc ?? "", nif: row.nif ?? "", rib: masquerSensibles("CompanyContact", { rib: row.rib }).rib ?? "",
        notes: pick("notes", row.notes),
      };
      const activeRaw = opStr(input, "active");
      const isActive = activeRaw ? !/^(inactif|inactive|non|off|d[ée]sactiv)/.test(fold(activeRaw)) : row.isActive;
      void user;
      return {
        title: `Corriger le contact « ${row.name} »`,
        fields: fieldsOf([
          ["Nom", name !== row.name ? `${row.name} → ${name}` : row.name],
          ["Nature", next.kind || "—"], ["Personne", next.contactName || "—"],
          ["Téléphone", next.phone || "—"], ["E-mail", next.email || "—"],
          ["Adresse", [next.address, next.city, next.wilaya].filter(Boolean).join(", ") || "—"],
          ["Actif", isActive ? "oui" : "non (mis de côté)"],
        ]),
        warnings: ["Fiche REMPLACÉE par l'action : tous les champs non cités sont rejoués à l'identique (FUSION)."],
        args: {
          id: row.id, name, kind: next.kind || null, contactName: next.contactName || null,
          phone: next.phone || null, phoneAlt: next.phoneAlt || null, email: next.email || null,
          website: next.website || null, address: next.address || null, city: next.city || null,
          wilaya: next.wilaya || null, rc: next.rc || null, nif: next.nif || null, rib: next.rib || null,
          notes: next.notes || null, isActive: isActive ? "1" : "0",
        },
        successMessage: `Contact « ${name} » corrigé.`,
      };
    },
    execute: (args) => runFd(updateCompanyContact, args, "Correction refusée."),
  },

  delete_company_contact: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const q = opStr(input, "name");
      if (!q) return { error: "Nommez le contact à retirer (champ « name »)." };
      const rows = await prisma.companyContact.findMany({
        where: { name: { contains: q, mode: "insensitive" } },
        select: { id: true, name: true, kind: true }, take: 6,
      });
      if (rows.length === 0) return { error: `Aucun contact « ${q} » à l'annuaire d'entreprise.` };
      if (rows.length > 1 && !rows.some((r) => fold(r.name) === fold(q))) {
        return { error: `Plusieurs contacts correspondent à « ${q} » : ${rows.map((r) => r.name).join(", ")} — préciser.` };
      }
      const row = rows.find((r) => fold(r.name) === fold(q)) ?? rows[0];
      return {
        title: `Retirer « ${row.name} » de l'annuaire d'entreprise`,
        fields: fieldsOf([["Contact", row.name], ["Nature", row.kind || "—"]]),
        warnings: ["Suppression RÉELLE (un annuaire n'a pas d'historique à préserver) — pour un prestataire mis de côté, préférez le passer inactif (update_company_contact)."],
        args: { id: row.id },
        successMessage: `Contact « ${row.name} » retiré.`,
      };
    },
    execute: (args) => runFd(deleteCompanyContact, args, "Retrait refusé."),
  },

  update_department: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const d = await resolveDepartment(opStr(input, "department") || opStr(input, "name"));
      if ("error" in d) return d;
      const name = opStr(input, "newName") || d.name;
      let parentId = d.parentId ?? "";
      let parentShown = "—";
      const parentRaw = opStr(input, "parent");
      if (parentRaw) {
        if (/^aucun/.test(fold(parentRaw)) || /^racine/.test(fold(parentRaw))) { parentId = ""; parentShown = "aucun (département de tête)"; }
        else {
          const p = await resolveDepartment(parentRaw);
          if ("error" in p) return p;
          if (p.id === d.id) return { error: "Un département ne peut pas être son propre parent." };
          parentId = p.id; parentShown = p.name;
        }
      } else if (d.parentId) {
        const p = await prisma.department.findUnique({ where: { id: d.parentId }, select: { name: true } });
        parentShown = p?.name ?? "—";
      }
      let headId = d.headId ?? ""; let headShown = "—";
      const headRaw = opStr(input, "head");
      if (headRaw) {
        if (/^aucun/.test(fold(headRaw))) { headId = ""; headShown = "aucun"; }
        else {
          const e = await resolveEmployee(headRaw);
          if ("error" in e) return e;
          headId = e.id; headShown = e.fullName;
        }
      } else if (d.headId) {
        const e = await prisma.employee.findUnique({ where: { id: d.headId }, select: { fullName: true } });
        headShown = e?.fullName ?? "—";
      }
      let deputyId = d.deputyId ?? ""; let deputyShown = "—";
      const deputyRaw = opStr(input, "deputy");
      if (deputyRaw) {
        if (/^aucun/.test(fold(deputyRaw))) { deputyId = ""; deputyShown = "aucun"; }
        else {
          const e = await resolveEmployee(deputyRaw);
          if ("error" in e) return e;
          deputyId = e.id; deputyShown = e.fullName;
        }
      } else if (d.deputyId) {
        const e = await prisma.employee.findUnique({ where: { id: d.deputyId }, select: { fullName: true } });
        deputyShown = e?.fullName ?? "—";
      }
      const description = opStr(input, "notes") || d.description || "";
      return {
        title: `Modifier le département « ${d.name} »`,
        fields: fieldsOf([
          ["Nom", name !== d.name ? `${d.name} → ${name}` : d.name],
          ["Rattaché à", parentShown],
          ["Responsable", headShown], ["Adjoint", deputyShown],
          ["Description", description || "—"],
        ]),
        warnings: [
          "Fiche REMPLACÉE par l'action : rattachement, responsable, adjoint et description non cités sont rejoués à l'identique (FUSION).",
          "Le re-rattachement interdit les CYCLES ; un sous-département suit toujours l'entité de son parent ; le libellé des employés suit le renommage.",
        ],
        args: { id: d.id, name, parentId: parentId || null, description: description || null, headId: headId || null, deputyId: deputyId || null },
        successMessage: `Département « ${name} » modifié.`,
      };
    },
    execute: (args) => runFd(updateDepartment, args, "Modification refusée."),
  },

  delete_department: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const d = await resolveDepartment(opStr(input, "department") || opStr(input, "name"));
      if ("error" in d) return d;
      const [children, members] = await Promise.all([
        prisma.department.count({ where: { parentId: d.id } }),
        prisma.employee.count({ where: { departmentId: d.id } }),
      ]);
      return {
        title: `Supprimer le département « ${d.name} »`,
        fields: fieldsOf([
          ["Département", d.name],
          ["Sous-départements", children ? `${children} — remontent d'un cran (jamais orphelins)` : "aucun"],
          ["Membres", members ? `${members} — repassent « non affectés »` : "aucun"],
        ]),
        warnings: ["La structure est supprimée ; les employés et comptes ne sont PAS supprimés (détachés seulement)."],
        args: { id: d.id },
        successMessage: `Département « ${d.name} » supprimé.`,
      };
    },
    execute: (args) => runFd(deleteDepartment, args, "Suppression refusée."),
  },

  save_org_node: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const e = await resolveEmployee(opStr(input, "employee") || opStr(input, "name"));
      if ("error" in e) return e;
      const row = await prisma.employee.findUnique({ where: { id: e.id }, select: { managerId: true, position: true } });
      let managerId = row?.managerId ?? ""; let managerShown = "—";
      const managerRaw = opStr(input, "manager");
      if (managerRaw) {
        if (/^aucun/.test(fold(managerRaw))) { managerId = ""; managerShown = "aucun (retiré)"; }
        else {
          const m = await resolveEmployee(managerRaw);
          if ("error" in m) return m;
          if (m.id === e.id) return { error: "Un employé ne peut pas être son propre N+1." };
          managerId = m.id; managerShown = m.fullName;
        }
      } else if (row?.managerId) {
        const m = await prisma.employee.findUnique({ where: { id: row.managerId }, select: { fullName: true } });
        managerShown = m?.fullName ?? "—";
      }
      const position = opStr(input, "position") || row?.position || "";
      return {
        title: `Organigramme — rattacher ${e.fullName}`,
        fields: fieldsOf([["Employé", e.fullName], ["N+1", managerShown], ["Poste", position || "—"]]),
        warnings: ["Le N+1 non cité est REJOUÉ à l'identique (l'action l'écrit toujours) ; la garde anti-boucle refuse un subordonné comme N+1."],
        args: { id: e.id, managerId: managerId || null, position: position || null },
        successMessage: `Organigramme mis à jour pour ${e.fullName}.`,
      };
    },
    execute: (args) => runFd(saveOrgNode, args, "Rattachement refusé."),
  },

  set_company_access: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const p = await resolveAccount(opStr(input, "person"));
      if ("error" in p) return p;
      const c = await resolveCompany(opStr(input, "company") || opStr(input, "name"));
      if ("error" in c) return c;
      if (p.id === user.id && user.role !== "SUPER_ADMIN") {
        return { error: "On ne modifie jamais ses PROPRES accès aux entités (garde structurelle) — un Super Admin passe par l'Administration." };
      }
      const modeRaw = fold(opStr(input, "mode") || opStr(input, "value"));
      let mode = ""; let shown = "";
      if (/retir|aucun|revoq|révoq|enlev/.test(modeRaw)) { mode = "none"; shown = "retiré"; }
      else if (/modif|edit|écri|ecri/.test(modeRaw)) { mode = "edit"; shown = "voir et modifier"; }
      else if (/voir|consult|lecture|view/.test(modeRaw)) { mode = "view"; shown = "voir seulement"; }
      else return { error: "Champ « mode » : « voir », « voir et modifier » ou « retirer »." };
      const existing = await prisma.userCompanyAccess.findUnique({
        where: { userId_companyId: { userId: p.id, companyId: c.id } }, select: { canEdit: true },
      });
      return {
        title: `Accès entité — ${p.name} / ${c.name}`,
        fields: fieldsOf([
          ["Personne", p.name], ["Entité", c.name],
          ["Accès", shown],
          ["Actuellement", existing ? (existing.canEdit ? "voir et modifier" : "voir seulement") : "aucun accès"],
        ]),
        warnings: ["L'appartenance (salarié de) et le DROIT D'ACCÈS sont deux choses distinctes — ceci règle le second."],
        args: { userId: p.id, companyId: c.id, mode },
        successMessage: `Accès de ${p.name} à « ${c.name} » : ${shown}.`,
      };
    },
    execute: (args) => runFd2(setCompanyAccess, args, "Réglage refusé."),
  },

  toggle_supplier_user: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const q = opStr(input, "person") || opStr(input, "email") || opStr(input, "name");
      if (!q) return { error: "Désignez le compte portail fournisseur (nom ou e-mail)." };
      const rows = await prisma.supplierUser.findMany({
        where: { OR: [{ name: { contains: q, mode: "insensitive" } }, { email: { contains: q, mode: "insensitive" } }] },
        select: { id: true, name: true, email: true, active: true, supplier: { select: { name: true } } }, take: 6,
      });
      if (rows.length === 0) return { error: `Aucun compte portail fournisseur « ${q} ».` };
      if (rows.length > 1) return { error: `Plusieurs comptes correspondent à « ${q} » : ${rows.map((r) => `${r.name} (${r.email})`).join(", ")} — préciser.` };
      const row = rows[0];
      return {
        title: `${row.active ? "Désactiver" : "Réactiver"} le compte portail « ${row.name} »`,
        fields: fieldsOf([
          ["Compte", `${row.name} — ${row.email}`], ["Fournisseur", row.supplier.name],
          ["État", `${row.active ? "actif" : "inactif"} → ${row.active ? "INACTIF (connexion refusée)" : "actif"}`],
        ]),
        warnings: ["Bascule : relancer l'op remettrait l'état précédent."],
        args: { id: row.id },
        successMessage: `Compte portail « ${row.name} » ${row.active ? "désactivé" : "réactivé"}.`,
      };
    },
    execute: (args) => runFd(toggleSupplierUser, args, "Bascule refusée."),
  },

  update_feedback_status: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const q = opStr(input, "target") || opStr(input, "comment");
      const rows = await prisma.feedback.findMany({
        orderBy: { createdAt: "desc" }, take: 12,
        select: { id: true, message: true, status: true, adminNote: true, user: { select: { name: true } } },
      });
      if (rows.length === 0) return { error: "Aucun feedback déposé." };
      const excerpt = (f: (typeof rows)[number]) => `« ${f.message.slice(0, 45)}${f.message.length > 45 ? "…" : ""} » (${f.user.name})`;
      let row = rows[0];
      if (q && !/^dernier/.test(fold(q))) {
        const hits = rows.filter((f) => fold(f.message).includes(fold(q)) || fold(f.user.name).includes(fold(q)));
        if (hits.length === 0) return { error: `Aucun feedback récent contenant « ${q} » — récents : ${rows.slice(0, 5).map(excerpt).join(" ; ")}.` };
        if (hits.length > 1) return { error: `Plusieurs feedbacks correspondent : ${hits.map(excerpt).join(" ; ")} — préciser l'extrait.` };
        row = hits[0];
      }
      const statusRaw = fold(opStr(input, "status"));
      let status = ""; let shown = "";
      if (/^(vu|seen)/.test(statusRaw)) { status = "SEEN"; shown = "vu"; }
      else if (/cours|progress/.test(statusRaw)) { status = "IN_PROGRESS"; shown = "en cours"; }
      else if (/trait|fait|done|termin/.test(statusRaw)) { status = "DONE"; shown = "traité"; }
      else if (/nouveau|new/.test(statusRaw)) { status = "NEW"; shown = "nouveau"; }
      else return { error: "Champ « status » : vu, en cours, traité (ou nouveau)." };
      const adminNote = opStr(input, "note") || row.adminNote || "";
      const warnings = ["Note de l'admin REMPLACÉE par l'action : sans nouvelle note, l'existante est rejouée (FUSION)."];
      if (adminNote && adminNote !== row.adminNote) warnings.push("La nouvelle note est NOTIFIÉE à l'auteur du feedback (boîte Feedback).");
      return {
        title: `Feedback → ${shown}`,
        fields: fieldsOf([["Feedback", excerpt(row)], ["Statut", `${row.status} → ${status}`], ["Note admin", adminNote || "—"]]),
        warnings,
        args: { id: row.id, status, adminNote: adminNote || null },
        successMessage: `Feedback marqué « ${shown} ».`,
      };
    },
    execute: (args) => runFd(updateFeedbackStatus, args, "Traitement refusé."),
  },

  attach_orphans_to_company: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const MODEL_PAIRS: [string, string][] = [
        ["regulatoryProduct", "Dossiers réglementaires"], ["administrativeRequest", "Demandes administratives"],
        ["sponsoringRequest", "Sponsoring"], ["congressInternational", "Prises en charge internationales"],
        ["congressNational", "Prises en charge nationales"], ["event", "Événements"],
        ["promoMaterial", "Matériel promotionnel"], ["promoStockItem", "Stock promotionnel"],
        ["budgetEnvelope", "Enveloppes budgétaires"], ["financeTransaction", "Mouvements de trésorerie"],
        ["expenseOrder", "Ordres de dépense"], ["medicalDoctor", "Praticiens (annuaire)"],
        ["fieldReport", "Rapports terrain"], ["medicalInfoDeclaration", "Information médicale"],
        ["pchTender", "Marchés PCH"], ["logisticsOrder", "Commandes logistiques"],
        ["sale", "Ventes"], ["dossier", "Sujets"],
      ];
      const model = matchLabel(opStr(input, "type") || opStr(input, "target"), MODEL_PAIRS);
      if (typeof model !== "string") return model;
      const label = MODEL_PAIRS.find(([m]) => m === model)?.[1] ?? model;
      const c = await resolveCompany(opStr(input, "company") || opStr(input, "name"));
      if ("error" in c) return c;
      const delegate = (prisma as unknown as Record<string, { count: (a: unknown) => Promise<number> }>)[model];
      const orphans = delegate?.count ? await delegate.count({ where: { companyId: null } }) : 0;
      if (orphans === 0) return { error: `Aucun enregistrement « ${label} » sans entité — rien à rattacher.` };
      return {
        title: `Rattacher les orphelins — ${label} → ${c.name}`,
        fields: fieldsOf([["Type", label], ["Entité", c.name], ["Sans entité aujourd'hui", `${orphans} enregistrement(s)`]]),
        warnings: ["SEULS les enregistrements SANS entité sont touchés — jamais un rattachement existant (on ne déplace pas le travail d'une société vers une autre)."],
        args: { model, companyId: c.id },
        successMessage: `Orphelins « ${label} » rattachés à ${c.name}.`,
      };
    },
    execute: (args) => runFd(attachOrphansToCompany, args, "Rattachement refusé."),
  },

  set_pipeline_access: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const kindRaw = fold(opStr(input, "kind") || opStr(input, "mode"));
      const isManagers = /cadenas|verrou|g[ée]r|ouvre|lock/.test(kindRaw);
      const isViewers = /consult|voir|lecture|view/.test(kindRaw);
      if (!isManagers && !isViewers) return { error: "Champ « kind » : « consultation » (voir les dossiers verrouillés) ou « cadenas » (verrouiller / ouvrir)." };
      const removing = /retir|enl[eè]v|sans|revoq|révoq/.test(fold(opStr(input, "mode")) + " " + fold(opStr(input, "value")));
      const s = await prisma.appSetting.findUnique({
        where: { id: "global" },
        select: { pipelineViewerRoles: true, pipelineViewerUserIds: true, pipelineManagerRoles: true, pipelineManagerUserIds: true },
      });
      const cur = {
        viewerRoles: s?.pipelineViewerRoles ?? [], viewerUserIds: s?.pipelineViewerUserIds ?? [],
        managerRoles: s?.pipelineManagerRoles ?? [], managerUserIds: s?.pipelineManagerUserIds ?? [],
      };
      let subjectShown = "";
      const personRaw = opStr(input, "person");
      const roleRaw = opStr(input, "role");
      if (!personRaw && !roleRaw) return { error: "Nommez une personne (« person ») ou un rôle (« role »)." };
      const next = { ...cur, viewerRoles: [...cur.viewerRoles], viewerUserIds: [...cur.viewerUserIds], managerRoles: [...cur.managerRoles], managerUserIds: [...cur.managerUserIds] };
      const listKey = isManagers ? ("managerUserIds" as const) : ("viewerUserIds" as const);
      const roleKey = isManagers ? ("managerRoles" as const) : ("viewerRoles" as const);
      if (personRaw) {
        const p = await resolveAccount(personRaw);
        if ("error" in p) return p;
        subjectShown = p.name;
        if (removing) next[listKey] = next[listKey].filter((id) => id !== p.id);
        else if (!next[listKey].includes(p.id)) next[listKey].push(p.id);
      } else {
        const role = matchLabel(roleRaw, ROLE_PAIRS_7D);
        if (typeof role !== "string") return role;
        subjectShown = `rôle « ${ROLE_LABELS[role as keyof typeof ROLE_LABELS] ?? role} »`;
        if (removing) next[roleKey] = next[roleKey].filter((r) => r !== role);
        else if (!next[roleKey].includes(role)) next[roleKey].push(role);
      }
      const listShown = isManagers ? "tient le CADENAS (verrouiller / ouvrir — ouvrir PUBLIE et ne se reprend pas)" : "consulte les dossiers verrouillés";
      return {
        title: `Accès pipeline — ${removing ? "retirer" : "ajouter"} ${subjectShown}`,
        fields: fieldsOf([
          ["Liste", listShown],
          ["Geste", `${removing ? "RETRAIT" : "AJOUT"} : ${subjectShown}`],
          ["Après", `${next[roleKey].length} rôle(s), ${next[listKey].length} personne(s) (le Super Admin reste toujours inclus)`],
        ]),
        warnings: ["Les DEUX listes sont REMPLACÉES par l'action : l'autre liste et les entrées non citées sont rejouées à l'identique (FUSION)."],
        args: {
          viewerRoles: JSON.stringify(next.viewerRoles), viewerUserIds: JSON.stringify(next.viewerUserIds),
          managerRoles: JSON.stringify(next.managerRoles), managerUserIds: JSON.stringify(next.managerUserIds),
        },
        successMessage: `Accès au pipeline mis à jour (${removing ? "retrait" : "ajout"} : ${subjectShown}).`,
      };
    },
    async execute(args) {
      const fd = new FormData();
      for (const [key, field] of [["viewerRoles", "viewerRoles"], ["viewerUserIds", "viewerUserIds"], ["managerRoles", "managerRoles"], ["managerUserIds", "managerUserIds"]] as const) {
        const list = JSON.parse(args[key] ?? "[]") as string[];
        for (const v of list) fd.append(field, v);
      }
      const r = await setPipelineAccess(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "Réglage refusé." };
      return { ok: true };
    },
  },

  set_row_grants: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const p = await resolveAccount(opStr(input, "person"));
      if ("error" in p) return p;
      const entityType = matchLabel(opStr(input, "type"), ENTITY_PAIRS_7D);
      if (typeof entityType !== "string") return entityType;
      const label = ENTITY_TYPE_LABELS[entityType as keyof typeof ENTITY_TYPE_LABELS] ?? entityType;
      const removing = /retir|enl[eè]v|revoq|révoq/.test(fold(opStr(input, "mode")));
      const rec = await resolveRecordOfType(entityType, opStr(input, "record") || opStr(input, "target"));
      if ("error" in rec) return rec;
      const current = await prisma.rowGrant.findMany({
        where: { userId: p.id, entityType: entityType as EntityType }, select: { entityId: true },
      });
      const ids = new Set(current.map((g) => g.entityId));
      if (removing && !ids.has(rec.id)) return { error: `${p.name} n'a pas de ligne accordée sur « ${rec.name} » — rien à retirer.` };
      if (!removing && ids.has(rec.id)) return { error: `${p.name} a DÉJÀ la ligne « ${rec.name} » (${label}).` };
      if (removing) ids.delete(rec.id); else ids.add(rec.id);
      return {
        title: `Lignes accordées — ${removing ? "retirer" : "accorder"} « ${rec.name} »`,
        fields: fieldsOf([
          ["Personne", p.name], ["Type", label],
          ["Ligne", rec.name],
          ["Après", `${ids.size} ligne(s) accordée(s) sur ce type`],
        ]),
        warnings: ["La liste des lignes de ce type est REMPLACÉE par l'action : les autres lignes sont rejouées à l'identique (FUSION)."],
        args: { userId: p.id, entityType, rowIds: JSON.stringify([...ids]) },
        successMessage: `Lignes « ${label} » de ${p.name} mises à jour (${removing ? "retrait" : "ajout"} : ${rec.name}).`,
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("userId", args.userId ?? "");
      fd.set("entityType", args.entityType ?? "");
      for (const id of JSON.parse(args.rowIds ?? "[]") as string[]) fd.append("rowId", id);
      const r = await setRowGrants(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "Réglage refusé." };
      return { ok: true };
    },
  },

  update_ai_settings: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const AI_PAIRS: [string, string][] = [
        ["masterEnabled", "Interrupteur général de l'IA"],
        ["assistantEnabled", "Assistant IA (chatbot)"],
        ["proactiveNudgesEnabled", "Suggestions proactives"],
        ["brainEnabled", "Adventum Brain"],
        ["processIntelEnabled", "Process Intelligence"],
        ["fieldReportAiEnabled", "Analyse des rapports terrain"],
        ["voiceTranscriptEnabled", "Transcription vocale (Whisper)"],
        ["siteWebAiEnabled", "Rédaction du site (articles et offres)"],
        ["lecturePiecesEnabled", "Lecture des pièces commerciales (lignes par l'IA)"],
        ["conseilPiecesEnabled", "Luna — conseil de rangement des pièces Ad & Pro"],
        ["ocrVisionEnabled", "OCR vision des conversions (pages scannées difficiles)"],
      ];
      const key = matchLabel(opStr(input, "feature") || opStr(input, "target"), AI_PAIRS);
      if (typeof key !== "string") return key;
      const label = AI_PAIRS.find(([k]) => k === key)?.[1] ?? key;
      const valueRaw = fold(opStr(input, "value") || opStr(input, "mode"));
      let on: boolean;
      if (/coup|d[ée]sactiv|off|non|arr[eê]t|[ée]tein/.test(valueRaw)) on = false;
      else if (/activ|allum|on|oui|r[ée]tabli/.test(valueRaw)) on = true;
      else return { error: "Champ « value » : « activer » ou « couper »." };
      const s = await prisma.aiSetting.findUnique({ where: { id: "global" } });
      const cur = {
        masterEnabled: s?.masterEnabled ?? true, assistantEnabled: s?.assistantEnabled ?? true,
        proactiveNudgesEnabled: s?.proactiveNudgesEnabled ?? true, brainEnabled: s?.brainEnabled ?? true,
        processIntelEnabled: s?.processIntelEnabled ?? true, fieldReportAiEnabled: s?.fieldReportAiEnabled ?? true,
        voiceTranscriptEnabled: s?.voiceTranscriptEnabled ?? true,
        siteWebAiEnabled: s?.siteWebAiEnabled ?? true,
        // Le défaut de la COLONNE, coupée (`ai-settings.ts`) : sans ligne, la lecture des pièces ne part pas.
        lecturePiecesEnabled: s?.lecturePiecesEnabled ?? false,
        conseilPiecesEnabled: s?.conseilPiecesEnabled ?? true,
        // COUPÉ comme sa colonne (décision 0019) : sans ligne, aucune page ne part au modèle de vision.
        ocrVisionEnabled: s?.ocrVisionEnabled ?? false,
      };
      if (cur[key as keyof typeof cur] === on) return { error: `« ${label} » est déjà ${on ? "activé" : "coupé"}.` };
      const next = { ...cur, [key]: on };
      const warnings = ["Les bascules non citées sont rejouées à l'identique (FUSION) — l'action les réécrit toutes."];
      if (key === "masterEnabled" && !on) warnings.push("INTERRUPTEUR GÉNÉRAL : couper ici coupe TOUTE l'IA — y compris cet assistant (il ne pourra plus rallumer lui-même).");
      return {
        title: `Centre de contrôle IA — ${on ? "activer" : "couper"} « ${label} »`,
        fields: fieldsOf([
          ["Fonction", label], ["Nouvel état", on ? "activée" : "COUPÉE"],
          ["Interrupteur général", next.masterEnabled ? "actif" : "COUPÉ (tout est éteint)"],
        ]),
        warnings,
        args: {
          masterEnabled: onOff(next.masterEnabled), assistantEnabled: onOff(next.assistantEnabled),
          proactiveNudgesEnabled: onOff(next.proactiveNudgesEnabled), brainEnabled: onOff(next.brainEnabled),
          processIntelEnabled: onOff(next.processIntelEnabled), fieldReportAiEnabled: onOff(next.fieldReportAiEnabled),
          voiceTranscriptEnabled: onOff(next.voiceTranscriptEnabled),
          siteWebAiEnabled: onOff(next.siteWebAiEnabled),
          lecturePiecesEnabled: onOff(next.lecturePiecesEnabled),
          conseilPiecesEnabled: onOff(next.conseilPiecesEnabled),
          ocrVisionEnabled: onOff(next.ocrVisionEnabled),
        },
        successMessage: `« ${label} » ${on ? "activé" : "coupé"}.`,
      };
    },
    execute: (args) => runFd(updateAiSettings, args, "Réglage refusé."),
  },

  set_feature_stage: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const q = opStr(input, "feature") || opStr(input, "name") || opStr(input, "target");
      if (!q) return { error: "Nommez la nouveauté (champ « feature »)." };
      const flags = await prisma.featureFlag.findMany({ select: { key: true, label: true, stage: true } });
      if (flags.length === 0) return { error: "Aucune nouveauté (feature flag) déclarée." };
      const hits = flags.filter((f) => fold(f.label).includes(fold(q)) || fold(f.key).includes(fold(q)));
      if (hits.length === 0) return { error: `Aucune nouveauté « ${q} ». Déclarées : ${flags.map((f) => f.label).join(" ; ")}.` };
      if (hits.length > 1) return { error: `Plusieurs nouveautés correspondent à « ${q} » : ${hits.map((f) => f.label).join(" ; ")} — préciser.` };
      const flag = hits[0];
      const stageRaw = fold(opStr(input, "value") || opStr(input, "mode") || opStr(input, "status"));
      let stage = ""; let shown = "";
      if (/prod|valid|tout le monde|publie/.test(stageRaw)) { stage = "PROD"; shown = "PRODUCTION (visible de TOUT LE MONDE)"; }
      else if (/test|recette|arri[eè]re/.test(stageRaw)) { stage = "TEST"; shown = "version de test (comptes en mode test seulement)"; }
      else if (/coup|off|d[ée]sactiv|[ée]teinte?/.test(stageRaw)) { stage = "OFF"; shown = "coupée"; }
      else return { error: "Champ « value » : production, test, ou coupée." };
      if (flag.stage === stage) return { error: `« ${flag.label} » est déjà en ${shown}.` };
      return {
        title: `Nouveauté « ${flag.label} » → ${stage}`,
        fields: fieldsOf([["Nouveauté", flag.label], ["Stade", `${flag.stage} → ${shown}`]]),
        warnings: stage === "PROD"
          ? ["Passage en PRODUCTION : la validation est tracée (qui, quand) ; un retour en test l'efface."]
          : ["Retour arrière / coupure : la trace de validation est effacée."],
        args: { key: flag.key, stage },
        successMessage: `« ${flag.label} » → ${shown}.`,
      };
    },
    execute: (args) => runFd(setFeatureStage, args, "Bascule refusée."),
  },

  update_risk_thresholds: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const PAIRS: [string, string][] = THRESHOLD_FIELDS.map((f) => [f.key as string, f.label]);
      const key = matchLabel(opStr(input, "field") || opStr(input, "target"), PAIRS);
      if (typeof key !== "string") return key;
      const def = THRESHOLD_FIELDS.find((f) => f.key === key)!;
      const valueRaw = opStr(input, "value").replace(",", ".");
      const n = Math.round(Number(valueRaw));
      if (!valueRaw || Number.isNaN(n)) return { error: `Champ « value » : la nouvelle valeur du seuil (nombre, entre ${def.min} et ${def.max}).` };
      const clamped = Math.max(def.min, Math.min(def.max, n));
      const s = await prisma.riskSetting.findUnique({ where: { id: "global" } });
      const args: Record<string, string | null> = {};
      const shownCur: number = (s as Record<string, unknown> | null)?.[key] as number ?? DEFAULT_THRESHOLDS[def.key];
      for (const f of THRESHOLD_FIELDS) {
        const cur = (s as Record<string, unknown> | null)?.[f.key] as number ?? DEFAULT_THRESHOLDS[f.key];
        args[f.key] = String(f.key === key ? clamped : cur);
      }
      const warnings = ["Les seuils non cités sont rejoués à l'identique (FUSION) — l'action réécrit la grille entière."];
      if (clamped !== n) warnings.push(`Valeur BORNÉE : ${n} → ${clamped} (plage ${def.min}–${def.max}).`);
      return {
        title: `Risk Radar — « ${def.label} »`,
        fields: fieldsOf([["Seuil", def.label], ["Valeur", `${shownCur}${def.suffix} → ${clamped}${def.suffix}`]]),
        warnings,
        args,
        successMessage: `Seuil « ${def.label} » réglé à ${clamped}${def.suffix}.`,
      };
    },
    execute: (args) => runFd(updateRiskThresholds, args, "Réglage refusé."),
  },

  purge_orphan_storage: {
    async propose(): Promise<OpProposalDraft | { error: string }> {
      return {
        title: "Purge du stockage — blobs orphelins",
        fields: fieldsOf([["Portée", "les contenus binaires que PLUS RIEN ne référence (dédupliqués, partagés)"]]),
        warnings: [
          "DESTRUCTION PHYSIQUE irréversible des blobs non référencés — c'est ce ramassage qui libère réellement l'espace disque.",
          "Un fichier encore référencé quelque part n'est JAMAIS touché.",
        ],
        confirmText: "PURGER",
        args: {},
        successMessage: "Purge du stockage effectuée.",
      };
    },
    async execute() {
      const r = await purgeOrphanStorage();
      if (!r.ok) return { ok: false, error: r.error ?? "Purge refusée." };
      const mb = r.bytes ? ` (${(r.bytes / 1048576).toFixed(1)} Mo libérés)` : "";
      return { ok: true, message: `Purge : ${r.count ?? 0} blob(s) orphelin(s) détruit(s)${mb}.`, revalidate: ["/admin/bases"] };
    },
  },

  permanently_delete_drive_node: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const q = opStr(input, "name") || opStr(input, "target");
      if (!q) return { error: "Nommez le fichier ou dossier Drive à détruire (champ « name »)." };
      const rows = await prisma.driveNode.findMany({
        where: { name: { contains: q, mode: "insensitive" } },
        select: { id: true, name: true, type: true, isTrashed: true }, take: 8,
      });
      if (rows.length === 0) return { error: `Aucun élément Drive « ${q} ».` };
      const exact = rows.filter((r) => fold(r.name) === fold(q));
      const pool = exact.length === 1 ? exact : rows;
      if (pool.length > 1) {
        return { error: `Plusieurs éléments correspondent à « ${q} » : ${pool.map((r) => `${r.name} (${r.type === "FOLDER" ? "dossier" : "fichier"}${r.isTrashed ? ", corbeille" : ""})`).join(" ; ")} — préciser le nom exact.` };
      }
      const node = pool[0];
      let children = 0;
      if (node.type === "FOLDER") children = await prisma.driveNode.count({ where: { parentId: node.id } });
      return {
        title: `Suppression DÉFINITIVE Drive — « ${node.name} »`,
        fields: fieldsOf([
          ["Élément", `${node.name} (${node.type === "FOLDER" ? "dossier" : "fichier"}${node.isTrashed ? " — déjà en corbeille" : ""})`],
          ["Cascade", node.type === "FOLDER" ? `TOUTE l'arborescence part avec (${children} élément(s) directs)` : "versions incluses"],
        ]),
        warnings: [
          "IRRÉVERSIBLE : aucune corbeille — l'arborescence et les versions sont détruites, puis les blobs orphelins ramassés (espace réellement libéré).",
        ],
        confirmText: node.name,
        args: { id: node.id },
        successMessage: `« ${node.name} » définitivement supprimé du Drive.`,
      };
    },
    async execute(args) {
      const r = await permanentlyDeleteDriveNode(toFdLocal(args));
      if (!r.ok) return { ok: false, error: r.error ?? "Suppression refusée." };
      return { ok: true, message: `Supprimé — ${r.count ?? 0} blob(s) libéré(s).`, revalidate: ["/admin/bases"] };
    },
  },

  permanently_delete_document: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const q = opStr(input, "name") || opStr(input, "target");
      if (!q) return { error: "Nommez le document (bibliothèque d'un objet métier) à détruire (champ « name »)." };
      const rows = await prisma.document.findMany({
        where: { name: { contains: q, mode: "insensitive" } },
        select: { id: true, name: true, entityType: true }, take: 8,
      });
      if (rows.length === 0) return { error: `Aucun document « ${q} ».` };
      const exact = rows.filter((r) => fold(r.name) === fold(q));
      const pool = exact.length === 1 ? exact : rows;
      if (pool.length > 1) {
        return { error: `Plusieurs documents correspondent à « ${q} » : ${pool.map((r) => `${r.name} (${ENTITY_TYPE_LABELS[r.entityType as keyof typeof ENTITY_TYPE_LABELS] ?? r.entityType})`).join(" ; ")} — préciser le nom exact.` };
      }
      const doc = pool[0];
      return {
        title: `Suppression DÉFINITIVE — document « ${doc.name} »`,
        fields: fieldsOf([
          ["Document", doc.name],
          ["Rattaché à", ENTITY_TYPE_LABELS[doc.entityType as keyof typeof ENTITY_TYPE_LABELS] ?? doc.entityType ?? "—"],
        ]),
        warnings: ["IRRÉVERSIBLE : la référence de stockage part ; le contenu binaire est détruit si plus personne ne le référence."],
        confirmText: doc.name,
        args: { id: doc.id },
        successMessage: `Document « ${doc.name} » définitivement supprimé.`,
      };
    },
    execute: (args) => runFd(permanentlyDeleteDocument, args, "Suppression refusée."),
  },
};

/** FormData local (même contrat que helpers.toFd — ici pour un retour typé count/bytes). */
function toFdLocal(args: Record<string, string | null>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(args)) {
    if (v !== null && v !== "") fd.set(k, v);
  }
  return fd;
}

// ─────────────────────────── LEGAL ───────────────────────────

export const LEGAL7D_OPS_IMPL: Record<string, OpImpl> = {
  save_company_identity: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const mine = await getMyCompanies(user.id);
      if (mine.length === 0) return { error: "Aucune entité dans votre périmètre." };
      const companyRaw = opStr(input, "company") || opStr(input, "name");
      let company = mine.length === 1 ? mine[0] : null;
      if (companyRaw) {
        const hit = mine.find((c) => fold(c.name).includes(fold(companyRaw)) || fold(companyRaw).includes(fold(c.name)));
        if (!hit) return { error: `« ${companyRaw} » n'est pas dans votre périmètre. Vos entités : ${mine.map((c) => c.name).join(", ")}.` };
        company = hit;
      }
      if (!company) return { error: `Nommez l'entité (champ « company ») : ${mine.map((c) => c.name).join(", ")}.` };
      const FIELD_PAIRS: [string, string][] = IDENTITY_SECTIONS.flatMap((s) => s.fields.map((f) => [f.key, f.label] as [string, string]));
      const key = matchLabel(opStr(input, "field"), FIELD_PAIRS);
      if (typeof key !== "string") return key;
      const label = FIELD_PAIRS.find(([k]) => k === key)?.[1] ?? key;
      const valueRaw = opStr(input, "value");
      const clearing = /^aucun|^vide|^efface/.test(fold(valueRaw));
      if (!valueRaw) return { error: `Champ « value » : la nouvelle valeur de « ${label} » (« aucun » pour vider).` };
      const existing = await prisma.companyLegalIdentity.findUnique({ where: { companyId: company.id } });
      const args: Record<string, string | null> = { companyId: company.id };
      let before = "—";
      for (const k of identityFieldKeys()) {
        const cur = ((existing as Record<string, unknown> | null)?.[k] as string | null) ?? null;
        if (k === key) { before = cur || "—"; args[k] = clearing ? null : valueRaw; }
        else args[k] = cur;
      }
      return {
        title: `Carte d'identité légale — ${company.name}`,
        fields: fieldsOf([
          ["Entité", company.name],
          [label, `${before} → ${clearing ? "(vidé)" : valueRaw}`],
        ]),
        warnings: [
          "Ces numéros ENGAGENT la société (appels d'offres, dossiers bancaires) — vérifiez la valeur au caractère près.",
          "La carte est REMPLACÉE par l'action : les autres champs sont rejoués à l'identique (FUSION) ; rien n'est deviné.",
        ],
        args,
        successMessage: `« ${label} » de ${company.name} mis à jour.`,
      };
    },
    execute: (args) => runFd(saveCompanyIdentity, args, "Enregistrement refusé."),
  },
};

// ─────────────────────────── ESPACE DE TRAVAIL ───────────────────────────

export const WS7D_OPS_IMPL: Record<string, OpImpl> = {
  submit_feedback: {
    async propose(input, user: CurrentUser): Promise<OpProposalDraft | { error: string }> {
      const message = opStr(input, "note") || opStr(input, "comment");
      if (!message) return { error: "Le message du feedback est obligatoire (champ « note »)." };
      const module = opStr(input, "module");
      return {
        title: "Envoyer un feedback",
        fields: fieldsOf([
          ["De", user.name],
          ["Module concerné", module || "—"],
          ["Message", message.length > 120 ? `${message.slice(0, 120)}…` : message],
        ]),
        warnings: ["Le feedback part aux Super Admins (notifiés) — leur réponse arrivera dans votre boîte Feedback."],
        args: { message, module: module || null },
        successMessage: "Feedback envoyé — merci.",
      };
    },
    execute: (args) => runFd2(submitFeedback, args, "Envoi refusé.", { link: "/feedback" }),
  },

  set_custom_field: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const entityType = matchLabel(opStr(input, "kind") || opStr(input, "type"), ENTITY_PAIRS_7D);
      if (typeof entityType !== "string") return entityType;
      if (!(CUSTOM_ENTITY_TYPES as string[]).includes(entityType)) {
        return { error: `Le type « ${ENTITY_TYPE_LABELS[entityType as keyof typeof ENTITY_TYPE_LABELS] ?? entityType} » n'a pas de champs personnalisés. Types équipés : ${CUSTOM_ENTITY_TYPES.map((t) => ENTITY_TYPE_LABELS[t as keyof typeof ENTITY_TYPE_LABELS] ?? t).join(", ")}.` };
      }
      const defs = await getFieldDefs(entityType as EntityType);
      if (defs.length === 0) return { error: `Aucun champ personnalisé défini pour « ${ENTITY_TYPE_LABELS[entityType as keyof typeof ENTITY_TYPE_LABELS] ?? entityType} » (l'administrateur les crée dans Administration → Champs).` };
      const rec = await resolveRecordOfType(entityType, opStr(input, "target") || opStr(input, "record"));
      if ("error" in rec) return rec;
      const def = (() => {
        const m = matchLabel(opStr(input, "field"), defs.map((d) => [d.key, d.label] as [string, string]));
        return typeof m === "string" ? defs.find((d) => d.key === m)! : m;
      })();
      if (!("key" in def)) return def;
      if (def.type === "FILE") {
        return { error: `« ${def.label} » est un champ FICHIER (référence Drive) — réglez-le depuis la fiche (l'explorateur Drive y vérifie vos accès).` };
      }
      const valueRaw = opStr(input, "value");
      if (!valueRaw) return { error: `Champ « value » : la valeur de « ${def.label} » (« aucun » pour vider${def.type === "BOOLEAN" ? " ; oui / non" : ""}).` };
      const clearing = /^aucun|^vide|^efface/.test(fold(valueRaw));
      let newShown = valueRaw;
      let newValue: string | null = valueRaw;
      if (def.type === "BOOLEAN") {
        const yes = /^(oui|vrai|on|coch|1)/.test(fold(valueRaw));
        newValue = yes ? "on" : null;
        newShown = yes ? "oui" : "non";
      } else if (def.type === "NUMBER") {
        if (clearing) { newValue = null; newShown = "(vidé)"; }
        else {
          const n = Number(valueRaw.replace(",", "."));
          if (Number.isNaN(n)) return { error: `« ${def.label} » attend un NOMBRE — reçu « ${valueRaw} ».` };
          newValue = String(n); newShown = String(n);
        }
      } else if (clearing) { newValue = null; newShown = "(vidé)"; }
      const current = await readCustomValues(entityType as EntityType, rec.id);
      const args: Record<string, string | null> = { entityType, entityId: rec.id };
      let before = "—";
      for (const d of defs) {
        const cur = current[d.key];
        let replay: string | null = null;
        if (d.type === "BOOLEAN") replay = cur === true ? "on" : null;
        else if (d.type === "NUMBER") replay = typeof cur === "number" ? String(cur) : null;
        else if (d.type === "FILE") replay = (cur as { nodeId?: string } | null)?.nodeId ?? null;
        else replay = typeof cur === "string" && cur ? cur : null;
        if (d.key === def.key) {
          before = d.type === "BOOLEAN" ? (cur === true ? "oui" : "non") : (replay ?? "—");
          args[`cf_${d.key}`] = newValue;
        } else args[`cf_${d.key}`] = replay;
      }
      return {
        title: `Champ personnalisé — « ${def.label} »`,
        fields: fieldsOf([
          ["Objet", `${rec.name} (${ENTITY_TYPE_LABELS[entityType as keyof typeof ENTITY_TYPE_LABELS] ?? entityType})`],
          [def.label, `${before} → ${newShown}`],
        ]),
        warnings: [
          "Les autres champs personnalisés sont rejoués à l'identique (FUSION) ; les champs OBLIGATOIRES vides feraient refuser l'action.",
          "Le droit de MODIFICATION sur l'objet est revérifié par l'action.",
        ],
        args,
        successMessage: `« ${def.label} » de ${rec.name} mis à jour.`,
      };
    },
    execute: (args) => runFd(saveCustomValues, args, "Mise à jour refusée."),
  },

  delete_own_record: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const KIND_PAIRS: [DeletableKind, string][] = [["MAIL_ENTRY", "Courrier"], ["LEGAL_DOCUMENT", "Document légal"]];
      const kind = matchLabel(opStr(input, "kind") || opStr(input, "type"), KIND_PAIRS);
      if (typeof kind !== "string") return kind;
      const label = KIND_PAIRS.find(([k]) => k === kind)?.[1] ?? kind;
      const q = opStr(input, "target") || opStr(input, "reference") || opStr(input, "name");
      if (!q) return { error: `Désignez le ${label.toLowerCase()} (référence ou titre — champ « target »).` };
      const hit = await resolveDeletableTarget(kind, q);
      if (hit.status === "ambiguous") {
        return { error: `Plusieurs éléments (${label}) correspondent à « ${q} » : ${hit.candidates.map((c) => c.name).join(" ; ")} — préciser.` };
      }
      if (hit.status === "none") return { error: `Aucun élément « ${q} » (${label}).` };
      return {
        title: `Supprimer le ${label.toLowerCase()} « ${hit.name} »`,
        fields: fieldsOf([["Type", label], ["Élément", hit.name]]),
        warnings: [
          "RÉVERSIBLE : instantané déposé dans la corbeille (Administration) — un administrateur peut le restaurer.",
          "Réservé au CRÉATEUR de l'objet, au droit DELETE du module, ou au Super Admin — revérifié par l'action.",
        ],
        args: { kind, id: hit.id },
        successMessage: `${label} « ${hit.name} » supprimé (corbeille).`,
      };
    },
    execute: (args) => runFd(deleteOwnRecord, args, "Suppression refusée."),
  },
};
