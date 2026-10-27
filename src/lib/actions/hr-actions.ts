"use server";

import { revalidatePath } from "next/cache";
import type { ContractType, LeaveType, LeaveStatus, UserRole } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { userCan, rolesWithModule } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { recordAudit, recordFieldChanges } from "@/lib/audit";
import { createExpenseOrder } from "@/lib/expense-orders";
import { askClaude, aiConfigured, cleModeleRequise } from "@/lib/ai";
import { phraseIaNonConfiguree } from "@/lib/ia/cle-manquante";
import { ocrDocument, canOcr } from "@/lib/regulatory/intelligence/ocr/ocr-engine";
import { notifyUser, notifyRoles } from "@/lib/notify";
import {
  createLeaveRequest, attachLeaveFiles, leaveDecider, revalidateLeaveViews,
} from "@/lib/hr/leave-core";
import {
  canDecideLeave, applyLeaveDecision, stageNotifyRoles, LEAVE_STAGE_LABELS, type LeaveStage,
} from "@/lib/leave-workflow";
import { fdStr, fdNum, fdDate, fdBool, type ActionResult } from "@/lib/actions/types";
import { remonterConge, trancherSousEscalade } from "@/lib/hr/conge-escalade";
import { LIEN_CONGES_A_SIGNER, LIEN_MES_CONGES, LIEN_MES_AVANCES, CHEMIN_PAIE_RH } from "@/lib/chemins/rh";
import { entitePermisePourFiche } from "@/lib/company";
import { compteSuitLaFiche } from "@/lib/hr/depart";
import { chargerSalairesPartis } from "@/lib/hr/salaires-partis";
import { decisionRattachement } from "@/lib/hr/rattachement-paie";
import { alignerSurLaFiche } from "@/lib/org/source-unique";
import { doubleEcrireCoffre } from "@/lib/coffre/ecriture";
import { champsNonSaisis } from "@/lib/coffre/champs";
// LA FRONTIÈRE — l'ERP annonce ses faits ; il ne sait pas qui les écoute, et c'est le principe.
import { emit } from "@/platform/events";

/** Inclusive calendar-day count between two dates (min 1). */
function daysBetween(start: Date, end: Date): number {
  const ms = end.getTime() - start.getTime();
  if (Number.isNaN(ms) || ms < 0) return 1;
  return Math.floor(ms / 86_400_000) + 1;
}

function castContract(v: string | null): ContractType | null {
  return v ? (v as ContractType) : null;
}

// ─────────────────────────────── Employees ───────────────────────────────

export async function createEmployee(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "EMPLOYEES", "CREATE")) return { ok: false, error: "Non autorisé." };

  const fullName = fdStr(formData, "fullName");
  if (!fullName) return { ok: false, error: "Le nom complet est obligatoire." };

  // L'ENTITÉ est l'une de celles que le formulaire propose (`getMyCompanies`) : un identifiant forgé rangeait
  // un salarié chez une société que la RH ne voit pas (§118.184 — audit 360°, S13).
  const companyIdSaisi = fdStr(formData, "companyId") || null;
  if (!(await entitePermisePourFiche(user.id, companyIdSaisi))) return { ok: false, error: "Cette entité ne vous est pas ouverte." };
  const dept = await resolveDepartmentFields(formData);
  let created;
  try {
    created = await prisma.employee.create({
      data: {
        fullName,
        position: fdStr(formData, "position"),
        ...(dept ?? {}),
        email: fdStr(formData, "email"),
        phone: fdStr(formData, "phone"),
        iban: fdStr(formData, "iban"),
        baseSalary: fdNum(formData, "baseSalary") ?? 0,
        hireDate: fdDate(formData, "hireDate"),
        contractType: castContract(fdStr(formData, "contractType")),
        contractStart: fdDate(formData, "contractStart"),
        contractEnd: fdDate(formData, "contractEnd"),
        leaveBalanceDays: fdNum(formData, "leaveBalanceDays") ?? 30,
        birthDate: fdDate(formData, "birthDate"),
        nationalId: fdStr(formData, "nationalId"),
        cnasNumber: fdStr(formData, "cnasNumber"),
        address: fdStr(formData, "address"),
        userId: fdStr(formData, "userId"),
        managerId: fdStr(formData, "managerId"),
        companyId: companyIdSaisi,
      },
    });
  } catch {
    return { ok: false, error: "Création impossible : ce compte applicatif est déjà lié à un employé." };
  }

  // Le compte applicatif lié hérite du département (permissions, périmètres, notifications).
  // L'organigramme est la seule source : le compte suit la fiche (`org/source-unique.ts`), sans saisie à part.
  if (created.userId) await alignerSurLaFiche(created.id);
  // LE COFFRE (refonte V2-E) : IBAN, NIN et salaire copiés chiffrés — derrière l'interrupteur, jamais bloquant.
  await doubleEcrireCoffre("Employee", created.id, created, user.id);
  await recordAudit({
    actorId: user.id, action: "CREATE", module: "Ressources humaines",
    entityType: "EMPLOYEE", entityId: created.id, summary: `Employé « ${fullName} »${created.department ? ` — ${created.department}` : ""}`,
  });
  // LE FAIT EST ANNONCÉ à la frontière, APRÈS que l'écriture soit acquise. `emit` ne lève
  // jamais : instrumenter une action RH ne doit pas pouvoir la faire échouer.
  emit({
    type: "hr.employee-added",
    subject: { type: "employee", id: created.id },
    actorId: user.id,
    data: { fullName, department: created.department ?? null },
  });
  revalidatePath("/rh");
  revalidatePath("/rh/departements");
  return { ok: true, id: created.id };
}

/**
 * Résout le rattachement au département à partir du formulaire :
 *   • `departmentId` (sélecteur structuré) → on lie et on met à jour le libellé cache ;
 *   • à défaut `department` (texte libre, ex. extrait d'un contrat par l'IA) → on tente de
 *     retrouver un département de même nom pour le lier, sinon on garde le texte seul.
 * Renvoie `undefined` si le formulaire ne parle pas de département (update partiel).
 */
async function resolveDepartmentFields(formData: FormData): Promise<{ departmentId: string | null; department: string | null } | undefined> {
  const hasId = formData.has("departmentId");
  const hasText = formData.has("department");
  if (!hasId && !hasText) return undefined;

  const departmentId = fdStr(formData, "departmentId");
  if (departmentId) {
    const dept = await prisma.department.findUnique({ where: { id: departmentId }, select: { name: true } });
    if (dept) return { departmentId, department: dept.name };
  }
  const label = fdStr(formData, "department");
  if (label) {
    const match = await prisma.department.findFirst({ where: { name: { equals: label, mode: "insensitive" } }, select: { id: true, name: true } });
    return match ? { departmentId: match.id, department: match.name } : { departmentId: null, department: label };
  }
  return { departmentId: null, department: null };
}

export async function updateEmployee(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "EMPLOYEES", "UPDATE")) return { ok: false, error: "Non autorisé." };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Employé introuvable." };

  const before = await prisma.employee.findUnique({ where: { id } });
  // LA PORTE DE LA FICHE (`/rh/[id]` lit `entitePermisePourFiche`) : la RH d'une société modifiait, par
  // l'identifiant, la fiche d'un salarié d'une autre (§118.184 — audit 360°, S13).
  if (!before || !(await entitePermisePourFiche(user.id, before.companyId))) return { ok: false, error: "Employé introuvable." };
  const companyIdSaisi = fdStr(formData, "companyId") || null;
  if (!(await entitePermisePourFiche(user.id, companyIdSaisi))) return { ok: false, error: "Cette entité ne vous est pas ouverte." };
  // CHANGER L'ENTITÉ D'UNE FICHE DÉPLACE L'ATTRIBUTION DE SES SALAIRES (les lignes de paie suivent la fiche) :
  // un salaire déjà parti au nom d'une autre société ne change pas d'entité en silence — la même règle que
  // « rattacher » depuis l'écran de la paie (`decisionRattachement`, une seule lecture des salaires partis).
  if (companyIdSaisi !== before.companyId) {
    const { partisParSalarie } = await chargerSalairesPartis([id]);
    const societes = await prisma.company.findMany({ select: { id: true, name: true, shortName: true } });
    const nomDe = new Map(societes.map((c) => [c.id, c.shortName || c.name]));
    const decision = decisionRattachement(
      [{ id, nom: before.fullName, salairesPartis: partisParSalarie.get(id) ?? [] }],
      { id: companyIdSaisi ?? "", nom: companyIdSaisi ? nomDe.get(companyIdSaisi) ?? "cette entité" : "aucune entité" },
      (cid) => nomDe.get(cid) ?? "une entité supprimée",
    );
    if (!decision.ok) return { ok: false, error: decision.refus };
  }

  const deptFields = await resolveDepartmentFields(formData);
  const data = {
    fullName: fdStr(formData, "fullName") ?? before.fullName,
    position: fdStr(formData, "position"),
    // Rattachement structuré + libellé cache (inchangés si le formulaire n'en parle pas).
    ...(deptFields ?? { department: before.department, departmentId: before.departmentId }),
    email: fdStr(formData, "email"),
    phone: fdStr(formData, "phone"),
    iban: fdStr(formData, "iban"),
    baseSalary: fdNum(formData, "baseSalary") ?? 0,
    // Éléments de salaire du bulletin (brut, Ret SS 35 % et TFP restent confidentiels côté salarié).
    retSS9: fdNum(formData, "retSS9"),
    retSS35: fdNum(formData, "retSS35"),
    tfp: fdNum(formData, "tfp"),
    retIrg: fdNum(formData, "retIrg"),
    expenseRefund: fdNum(formData, "expenseRefund"),
    netToPay: fdNum(formData, "netToPay"),
    grossSalary: fdNum(formData, "grossSalary"),
    employerCost: fdNum(formData, "employerCost"),
    hireDate: fdDate(formData, "hireDate"),
    contractType: castContract(fdStr(formData, "contractType")),
    contractStart: fdDate(formData, "contractStart"),
    contractEnd: fdDate(formData, "contractEnd"),
    trialStart: fdDate(formData, "trialStart"),
    trialEnd: fdDate(formData, "trialEnd"),
    trialRenewable: fdBool(formData, "trialRenewable"),
    trialRenewed: fdBool(formData, "trialRenewed"),
    trialRenewalStart: fdDate(formData, "trialRenewalStart"),
    trialRenewalEnd: fdDate(formData, "trialRenewalEnd"),
    leaveBalanceDays: fdNum(formData, "leaveBalanceDays") ?? 0,
    birthDate: fdDate(formData, "birthDate"),
    nationalId: fdStr(formData, "nationalId"),
    cnasNumber: fdStr(formData, "cnasNumber"),
    address: fdStr(formData, "address"),
    userId: fdStr(formData, "userId"),
    managerId: fdStr(formData, "managerId"),
    companyId: companyIdSaisi, // entité de rattachement (modifiable)
    isActive: fdBool(formData, "isActive"),
  };

  // ÉCRIRE SANS LIRE (refonte V2-E) : une donnée sensible que l'écran ne montrait que masquée revient masquée
  // (ou ne revient pas) — elle reste en place, au lieu d'être vidée ou remise à zéro.
  for (const champ of champsNonSaisis("Employee", formData)) {
    (data as Record<string, unknown>)[champ] = (before as Record<string, unknown>)[champ];
  }

  let after;
  try {
    after = await prisma.employee.update({ where: { id }, data });
  } catch {
    return { ok: false, error: "Modification impossible : ce compte applicatif est déjà lié à un autre employé." };
  }
  // Le compte applicatif suit le rattachement de la fiche (permissions, périmètres, notifications).
  // Un compte nouvellement lié suit aussi la fiche, et celui qu'on délie ne garde pas un département qu'il ne tient plus.
  if (after.userId !== before.userId || after.departmentId !== before.departmentId) {
    await alignerSurLaFiche(id, before.userId);
  }
  await doubleEcrireCoffre("Employee", id, after, user.id);
  await recordFieldChanges(
    { actorId: user.id, module: "Ressources humaines", entityType: "EMPLOYEE", entityId: id, summary: `Fiche de ${after.fullName}` },
    before as unknown as Record<string, unknown>,
    after as unknown as Record<string, unknown>,
    ["fullName", "position", "department", "baseSalary", "contractType", "contractEnd", "leaveBalanceDays", "isActive", "userId", "managerId"],
  );
  // LE COMPTE SUIT LA FICHE quand elle change d'état (§118.184 — S13).
  const compte = before.isActive !== after.isActive ? await compteSuitLaFiche(user, after, after.isActive) : null;
  revalidatePath("/rh");
  revalidatePath(`/rh/${id}`);
  revalidatePath("/rh/departements");
  return compte ? { ok: true, id, message: compte } : { ok: true, id };
}

/**
 * Analyse d'un CONTRAT DE TRAVAIL par IA (OCR Mistral → Claude) pour PRÉ-REMPLIR la fiche
 * employé. Renvoie les champs extraits (jamais persistés ici : les RH relisent, corrigent
 * et enregistrent). N'enregistre AUCUN document (les RH versent eux-mêmes les pièces).
 */
const CONTRACT_SYSTEM = `Tu extrais les informations d'un CONTRAT DE TRAVAIL algérien (ou d'un avenant) afin
de préremplir la fiche RH d'un employé, à partir du texte du document (issu d'un OCR).

Tu renvoies UNIQUEMENT un objet JSON valide (aucun texte autour). Clés (mets "" si l'information
n'est pas présente dans le document) :
- "fullName" : nom complet de l'employé.
- "position" : intitulé du poste.
- "department" : département / service.
- "contractType" : l'une exactement de CDI, CDD, INTERIM, STAGE, FREELANCE, OTHER.
- "baseSalary" : salaire de base mensuel en DZD, chiffres uniquement (ex. "45000"), sinon "".
- "hireDate", "contractStart", "contractEnd", "birthDate" : au format AAAA-MM-JJ, sinon "".
- "email", "phone", "iban", "nationalId" (NIN), "cnasNumber" (n° sécurité sociale), "address".

RÈGLES : n'invente RIEN. Si une information est absente ou incertaine, mets "". Ne déduis pas de
date ou de salaire qui ne figurent pas explicitement dans le texte.`;

const CONTRACT_TYPES_UP = ["CDI", "CDD", "INTERIM", "STAGE", "FREELANCE", "OTHER"];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function analyzeEmployeeContract(
  formData: FormData,
): Promise<{ ok: boolean; error?: string; values?: Record<string, string> }> {
  const user = await requireUser();
  if (!userCan(user, "EMPLOYEES", "CREATE")) return { ok: false, error: "Non autorisé." };
  // Le nom de la clé se lit dans le registre (§118.128), jamais de mémoire.
  if (!aiConfigured()) return { ok: false, error: phraseIaNonConfiguree(cleModeleRequise(), "l'analyse automatique d'un contrat de travail") };
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choisissez le contrat de travail (PDF ou image)." };
  const ext = (file.name.split(".").pop() ?? "").toLowerCase();
  if (!canOcr(ext)) return { ok: false, error: `Format .${ext} non pris en charge pour l'OCR (PDF ou image).` };

  let text = "";
  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const ocr = await ocrDocument({ ext, buffer, langs: ["fra", "eng", "ara"], maxPages: 20 });
    text = ocr.pages.map((p) => p.text).join("\n").trim();
  } catch (err) {
    console.error("[hr] contract OCR failed", err);
    return { ok: false, error: "OCR du contrat impossible." };
  }
  if (text.length < 10) return { ok: false, error: "Le contrat ne contient pas de texte exploitable (OCR vide)." };

  const r = await askClaude(`Texte du contrat de travail :\n\n"""${text.slice(0, 20000)}"""\n\nRenvoie le JSON demandé.`, {
    system: CONTRACT_SYSTEM, maxTokens: 1500, temperature: 0.1,
  });
  if (!r.ok || !r.text) return { ok: false, error: r.error ?? "Analyse impossible." };
  const start = r.text.indexOf("{"); const end = r.text.lastIndexOf("}");
  if (start === -1 || end <= start) return { ok: false, error: "Réponse IA non exploitable." };
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(r.text.slice(start, end + 1)) as Record<string, unknown>; }
  catch { return { ok: false, error: "Réponse IA non exploitable." }; }

  const s = (k: string) => { const v = raw[k]; return v == null ? "" : String(v).trim(); };
  const values: Record<string, string> = {};
  for (const k of ["fullName", "position", "department", "email", "phone", "iban", "nationalId", "cnasNumber", "address"]) {
    const v = s(k); if (v) values[k] = v;
  }
  for (const k of ["hireDate", "contractStart", "contractEnd", "birthDate"]) {
    const v = s(k); if (ISO_DATE.test(v)) values[k] = v;
  }
  const ct = s("contractType").toUpperCase(); if (CONTRACT_TYPES_UP.includes(ct)) values.contractType = ct;
  const sal = s("baseSalary").replace(/[^\d.]/g, ""); if (sal && Number(sal) > 0) values.baseSalary = String(Math.round(Number(sal) * 100) / 100);

  if (!Object.keys(values).length) return { ok: false, error: "Aucune information exploitable détectée dans le contrat." };
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Ressources humaines", summary: `Analyse IA d'un contrat de travail — ${Object.keys(values).length} champ(s) préremplis` });
  return { ok: true, values };
}

export async function setEmployeeActive(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "EMPLOYEES", "UPDATE")) return { ok: false, error: "Non autorisé." };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Employé introuvable." };
  const isActive = fdBool(formData, "isActive");
  const fiche = await prisma.employee.findUnique({ where: { id }, select: { isActive: true, companyId: true, userId: true, fullName: true } });
  if (!fiche || !(await entitePermisePourFiche(user.id, fiche.companyId))) return { ok: false, error: "Employé introuvable." };
  await prisma.employee.update({ where: { id }, data: { isActive } });
  // LE COMPTE SUIT LA FICHE (§118.184 — S13) : une personne partie ne garde pas l'ERP.
  const compte = fiche.isActive !== isActive ? await compteSuitLaFiche(user, fiche, isActive) : null;
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Ressources humaines", entityType: "EMPLOYEE",
    entityId: id, field: "isActive", newValue: String(isActive), summary: isActive ? "Employé réactivé" : "Employé désactivé",
  });
  revalidatePath("/rh");
  revalidatePath(`/rh/${id}`);
  return compte ? { ok: true, message: compte } : { ok: true };
}

// ─────────────────────────────── Leave ───────────────────────────────

/**
 * Submit a leave request. Self-service by default (resolves the employee linked
 * to the current account); RH users may file on behalf of an employee by passing
 * `employeeId`.
 */
export async function requestLeave(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "WORKSPACE", "CREATE")) return { ok: false, error: "Non autorisé." };

  const explicitId = fdStr(formData, "employeeId");
  const isRh = userCan(user, "HR_REQUESTS", "CREATE");
  const employee = explicitId && isRh
    ? await prisma.employee.findUnique({ where: { id: explicitId } })
    : await prisma.employee.findUnique({ where: { userId: user.id } });
  if (!employee) {
    return { ok: false, error: "Aucune fiche employé n'est liée à votre compte. Contactez l'administrateur." };
  }

  const startDate = fdDate(formData, "startDate");
  const endDate = fdDate(formData, "endDate");
  if (!startDate || !endDate) return { ok: false, error: "Dates de début et de fin obligatoires." };
  if (endDate < startDate) return { ok: false, error: "La date de fin précède la date de début." };

  const days = fdNum(formData, "days") ?? daysBetween(startDate, endDate);

  const created = await createLeaveRequest(user.id, employee, {
    type: (fdStr(formData, "type") as LeaveType) ?? "ANNUAL",
    startDate, endDate, days,
    reason: fdStr(formData, "reason"),
    // La FICHE de demande (cf. `lib/hr/leave-sheet.ts`) : le téléphone où joindre la personne
    // — pré-rempli depuis sa fiche employé mais modifiable — et l'intérimaire qu'elle choisit.
    // Le reste (nom, fonction, recrutement, direction) se LIT de l'employé, jamais recopié.
    phone: fdStr(formData, "phone") ?? employee.phone,
    standInId: fdStr(formData, "standInId"),
  });

  // Justificatifs (certificat médical, formulaire signé…) : la demande les porte.
  const files = formData.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length) {
    const err = await attachLeaveFiles(created.id, files, user.id);
    if (err) return { ok: false, error: err };
  }

  revalidateLeaveViews(employee.id);
  return { ok: true, id: created.id };
}

/**
 * DÉCISION SUR UN CONGÉ — une marche du circuit N+1 → RH (cf. `leave-workflow.ts`).
 * Approuver fait monter d'un cran ; seule la dernière marche accorde réellement le congé
 * (et débite le solde). Refuser arrête tout.
 */
export async function decideLeave(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  const decision = fdStr(formData, "decision"); // APPROVED | REJECTED
  if (!id || (decision !== "APPROVED" && decision !== "REJECTED")) {
    return { ok: false, error: "Paramètres manquants." };
  }
  const leave = await prisma.leaveRequest.findUnique({ where: { id }, include: { employee: true } });
  if (!leave) return { ok: false, error: "Demande introuvable." };

  const decider = await leaveDecider(user, leave);
  const allowed = canDecideLeave(
    { status: leave.status, stage: leave.stage, requesterUserId: leave.employee.userId },
    decider,
  );
  if (!allowed.ok) return { ok: false, error: allowed.reason ?? "Non autorisé." };

  const note = fdStr(formData, "note");
  // LA MARCHE DU RESPONSABLE A PU ÊTRE REMONTÉE (Direction, 06/10) : l'avis du N+1 sollicité redescend chez qui l'a
  // demandé ; seul un refus, ou la validation du responsable de la demande, suit le circuit ordinaire.
  if (leave.stage === "MANAGER") {
    const sous = await trancherSousEscalade(user, id, decision, note, decider.isDg);
    if (sous && "continuer" in sous) { /* refus : le circuit ordinaire le pose ci-dessous */ }
    else if (sous) {
      if (sous.ok) revalidateLeaveViews(leave.employeeId);
      return sous.ok ? { ok: true, message: sous.message } : sous;
    }
  }
  const next = applyLeaveDecision(leave.stage as LeaveStage, decision);
  const now = new Date();

  // Trace par marche : qui a signé quoi, quand. Sans cela, un congé accordé ne dit plus
  // par qui il est passé — et c'est exactement ce qu'on demande six mois plus tard.
  const stampByStage: Record<string, Record<string, unknown>> = {
    MANAGER: { managerDecidedById: user.id, managerDecidedAt: now, managerNote: note },
    HR: { hrDecidedById: user.id, hrDecidedAt: now, hrNote: note },
    DG: { dgDecidedById: user.id, dgDecidedAt: now, dgNote: note },
  };

  // UN GESTE À LA FOIS (§118.196, E1) : la décision n'est écrite que sur la marche LUE, et le solde
  // se débite dans la MÊME transaction. « Une seule transition porte `granted` » était vrai d'un
  // circuit et faux de deux clics : deux accords finaux simultanés passaient tous les deux, et le
  // solde du salarié se débitait DEUX fois — un congé de cinq jours en coûtait dix, sans un mot.
  const ecrit = await prisma.$transaction(async (tx) => {
    const r = await tx.leaveRequest.updateMany({
      where: { id, status: "PENDING", stage: leave.stage },
      data: {
        status: next.status,
        stage: next.stage,
        ...(stampByStage[leave.stage] ?? {}),
        // La marche du responsable est franchie : plus personne ne la « tient ».
        ...(leave.stage === "MANAGER" ? { currentApproverId: null } : {}),
        // `decidedBy/At/Note` = la DERNIÈRE main posée sur la demande (compat historique + listes).
        decidedById: user.id, decidedAt: now, decisionNote: note,
      },
    });
    if (r.count === 0) return false;
    // Le solde ne bouge qu'au bout du circuit — et une seule fois : la transition qui porte
    // `granted` n'est écrite qu'une fois, par la condition ci-dessus.
    if (next.granted && leave.type === "ANNUAL") {
      await tx.employee.update({
        where: { id: leave.employeeId },
        data: { leaveBalanceDays: { decrement: Number(leave.days) } },
      });
    }
    return true;
  });
  if (!ecrit) return { ok: false, error: "Cette demande vient d'être tranchée par quelqu'un d'autre — rechargez la page." };

  const period = `${leave.startDate.toLocaleDateString("fr-FR")} → ${leave.endDate.toLocaleDateString("fr-FR")}`;
  if (next.status === "PENDING") {
    // Marche franchie : on prévient la suivante, et le demandeur suit l'avancement.
    const roles = stageNotifyRoles(next.stage) as UserRole[];
    if (roles.length) {
      await notifyRoles(roles, {
        type: "GENERIC", title: "Congé à valider",
        body: `${leave.employee.fullName} — ${period} (${Number(leave.days)} j). ${LEAVE_STAGE_LABELS[next.stage]}.`,
        link: LIEN_CONGES_A_SIGNER,
      });
    }
    if (leave.employee.userId) {
      await notifyUser({
        userId: leave.employee.userId, type: "GENERIC", title: "Congé : une étape de plus",
        body: `Votre demande ${period} avance — ${LEAVE_STAGE_LABELS[next.stage]}.`, link: LIEN_MES_CONGES,
      });
    }
  } else if (leave.employee.userId) {
    await notifyUser({
      userId: leave.employee.userId, type: "GENERIC",
      title: next.status === "APPROVED" ? "Congé approuvé" : "Congé refusé",
      body: `Votre demande ${period} a été ${next.status === "APPROVED" ? "approuvée" : "refusée"}.${note ? ` ${note}` : ""}`,
      link: LIEN_MES_CONGES,
    });
  }

  await recordAudit({
    actorId: user.id, action: decision === "APPROVED" ? "VALIDATE" : "REFUSE", module: "Ressources humaines",
    entityType: "LEAVE_REQUEST", entityId: id,
    summary: decision === "REJECTED"
      ? `Congé refusé (${LEAVE_STAGE_LABELS[leave.stage as LeaveStage]}) — ${leave.employee.fullName}`
      : next.granted
        ? `Congé accordé — ${leave.employee.fullName}`
        : `Congé validé (${LEAVE_STAGE_LABELS[leave.stage as LeaveStage]}) → ${LEAVE_STAGE_LABELS[next.stage]} — ${leave.employee.fullName}`,
  });
  revalidateLeaveViews(leave.employeeId);
  return { ok: true };
}

/**
 * DEMANDER À SON N+1 (Direction, 06/10) — celui qui tient la marche du responsable la remonte à son propre N+1, avec un
 * mot ; elle lui reviendra avec sa décision. Voir `lib/hr/conge-escalade.ts`.
 */
export async function demanderAvisN1Conge(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Demande non précisée." };
  const r = await remonterConge(user, id, fdStr(formData, "note"));
  if (!r.ok) return r;
  const leave = await prisma.leaveRequest.findUnique({ where: { id }, select: { employeeId: true } });
  if (leave) revalidateLeaveViews(leave.employeeId);
  revalidatePath("/mon-equipe");
  return { ok: true, id, message: r.message };
}

/** Cancel a still-pending leave request (by its author or an RH manager). */
export async function cancelLeave(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Demande introuvable." };
  const leave = await prisma.leaveRequest.findUnique({ where: { id }, include: { employee: true } });
  if (!leave) return { ok: false, error: "Demande introuvable." };

  const isOwner = leave.employee.userId === user.id;
  const isRh = userCan(user, "HR_REQUESTS", "UPDATE");
  if (!isOwner && !isRh) return { ok: false, error: "Non autorisé." };
  if (leave.status === "CANCELLED") return { ok: false, error: "Cette demande est déjà annulée." };
  // Le salarié ne retire que ce qui n'a pas encore été tranché. Les RH, eux, annulent AUSSI un
  // congé déjà décidé : un départ qui ne se fait finalement pas doit pouvoir être défait, sinon
  // le solde reste faux et l'historique ment.
  if (!isRh && leave.status !== "PENDING") {
    return { ok: false, error: "Cette demande a déjà été tranchée : demandez aux ressources humaines de l'annuler." };
  }

  // Annuler un congé annuel APPROUVÉ recrédite les jours : sans cela le salarié paierait un
  // congé qu'il n'a pas pris.
  const refund = leave.status === "APPROVED" && leave.type === "ANNUAL" ? Number(leave.days) : 0;

  // UN GESTE À LA FOIS : l'annulation s'écrit sur l'état ET la marche lus — une décision croisée
  // l'emporte, et deux clics ne recréditent pas deux fois. Le recrédit suit dans la même transaction.
  const annule = await prisma.$transaction(async (tx) => {
    const r = await tx.leaveRequest.updateMany({
      where: { id, status: leave.status, stage: leave.stage },
      // Le circuit s'arrête là : une demande retirée ne doit plus apparaître dans la file
      // d'aucune des trois marches.
      data: { status: "CANCELLED", stage: "DONE", decidedById: user.id, decidedAt: new Date() },
    });
    if (r.count === 1 && refund > 0) {
      await tx.employee.update({ where: { id: leave.employeeId }, data: { leaveBalanceDays: { increment: refund } } });
    }
    return r.count === 1;
  });
  if (!annule) return { ok: false, error: "Cette demande vient d'être tranchée — rechargez la page." };

  // CEUX QUI DEVAIENT LA TRAITER SONT PRÉVENUS (décision du 04/10) : la marche où elle attendait quand le
  // salarié la retire ; le salarié quand ce sont les RH qui l'annulent.
  const periodeAnnulee = `${leave.employee.fullName} — congé de ${Number(leave.days)} j : demande annulée${isOwner ? " par le salarié" : " par les RH"}.`;
  if (isOwner && leave.status === "PENDING") {
    if (leave.stage === "MANAGER" && leave.managerId) {
      const chef = await prisma.employee.findUnique({ where: { id: leave.managerId }, select: { userId: true } });
      if (chef?.userId && chef.userId !== user.id) {
        await notifyUser({ userId: chef.userId, type: "GENERIC", title: "Demande de congé annulée", body: periodeAnnulee, link: LIEN_CONGES_A_SIGNER }).catch(() => undefined);
      }
    } else {
      const roles = stageNotifyRoles(leave.stage as LeaveStage) as UserRole[];
      if (roles.length) await notifyRoles(roles, { type: "GENERIC", title: "Demande de congé annulée", body: periodeAnnulee, link: LIEN_CONGES_A_SIGNER }).catch(() => undefined);
    }
  } else if (!isOwner && leave.employee.userId) {
    await notifyUser({ userId: leave.employee.userId, type: "GENERIC", title: "Demande de congé annulée", body: periodeAnnulee, link: LIEN_MES_CONGES }).catch(() => undefined);
  }
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Ressources humaines", entityType: "LEAVE_REQUEST",
    entityId: id, field: "status", newValue: "CANCELLED",
    summary: `Demande de congé annulée${refund > 0 ? ` — ${refund} j recrédité(s) à ${leave.employee.fullName}` : ""}`,
  });
  revalidateLeaveViews(leave.employeeId);
  return { ok: true };
}

const LEAVE_STATUSES: LeaveStatus[] = ["PENDING", "APPROVED", "REJECTED", "CANCELLED"];

/**
 * MODIFICATION par les RH (DRH) d'une demande de congé — Y COMPRIS déjà décidée (historique) :
 * type, dates, jours, motif, STATUT (décision) et note. Le solde de congé annuel est réajusté
 * proprement : on annule le débit précédent (si la demande était approuvée en annuel) et on
 * applique le nouveau (si elle reste/est approuvée en annuel). Réservé au RH (droit UPDATE).
 */
export async function updateLeaveRequest(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "HR_REQUESTS", "UPDATE")) return { ok: false, error: "Réservé aux ressources humaines." };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Demande introuvable." };
  const leave = await prisma.leaveRequest.findUnique({ where: { id }, include: { employee: true } });
  if (!leave) return { ok: false, error: "Demande introuvable." };

  const startDate = fdDate(formData, "startDate") ?? leave.startDate;
  const endDate = fdDate(formData, "endDate") ?? leave.endDate;
  if (endDate < startDate) return { ok: false, error: "La date de fin précède la date de début." };
  const type = (fdStr(formData, "type") as LeaveType | null) ?? leave.type;
  const days = fdNum(formData, "days") ?? Number(leave.days);
  if (!(days >= 0)) return { ok: false, error: "Nombre de jours invalide." };
  const reason = formData.has("reason") ? fdStr(formData, "reason") : leave.reason;
  const statusRaw = fdStr(formData, "status");
  const status: LeaveStatus = statusRaw && (LEAVE_STATUSES as string[]).includes(statusRaw) ? (statusRaw as LeaveStatus) : leave.status;
  const decisionNote = formData.has("decisionNote") ? fdStr(formData, "decisionNote") : leave.decisionNote;

  // Réajustement du solde annuel : différence entre l'ancien débit et le nouveau.
  const oldDebit = leave.status === "APPROVED" && leave.type === "ANNUAL" ? Number(leave.days) : 0;
  const newDebit = status === "APPROVED" && type === "ANNUAL" ? days : 0;
  const balanceDelta = oldDebit - newDebit; // > 0 = on recrédite ; < 0 = on débite davantage

  const statusChanged = status !== leave.status;
  await prisma.leaveRequest.update({
    where: { id },
    data: {
      type, startDate, endDate, days, reason, status, decisionNote,
      // Décision retracée si elle change : décideur/date (ou remise à zéro si repassée « en attente »).
      // Le RH qui rouvre une demande la remet à SA marche : ce qu'il vient de trancher, il n'a
      // pas à le refaire trancher par le N+1.
      ...(statusChanged
        ? {
            decidedById: status === "PENDING" ? null : user.id,
            decidedAt: status === "PENDING" ? null : new Date(),
            stage: status === "PENDING" ? ("HR" as const) : ("DONE" as const),
          }
        : {}),
    },
  });
  if (balanceDelta !== 0) {
    await prisma.employee.update({ where: { id: leave.employeeId }, data: { leaveBalanceDays: { increment: balanceDelta } } });
  }
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Ressources humaines", entityType: "LEAVE_REQUEST", entityId: id,
    summary: `Congé modifié par RH — ${leave.employee.fullName} (${days} j, ${status})`,
  });
  revalidateLeaveViews(leave.employeeId);
  return { ok: true };
}

// ─────────────────────────── Avance sur salaire ───────────────────────────

/** Request a salary advance (self-service, or RH on behalf of an employee). */
export async function requestAdvance(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "WORKSPACE", "CREATE")) return { ok: false, error: "Non autorisé." };

  const explicitId = fdStr(formData, "employeeId");
  const isRh = userCan(user, "RH", "CREATE");
  const employee = explicitId && isRh
    ? await prisma.employee.findUnique({ where: { id: explicitId } })
    : await prisma.employee.findUnique({ where: { userId: user.id } });
  if (!employee) {
    return { ok: false, error: "Aucune fiche employé n'est liée à votre compte. Contactez l'administrateur." };
  }

  const amount = fdNum(formData, "amount");
  if (!amount || amount <= 0) return { ok: false, error: "Montant invalide." };

  const created = await prisma.salaryAdvance.create({
    data: { employeeId: employee.id, amount, reason: fdStr(formData, "reason"), createdById: user.id },
  });
  await recordAudit({
    actorId: user.id, action: "CREATE", module: "Ressources humaines",
    entityType: "SALARY_ADVANCE", entityId: created.id,
    summary: `Demande d'avance — ${employee.fullName}`,
  });
  revalidatePath("/mon-espace");
  revalidatePath("/rh");
  return { ok: true, id: created.id };
}

/** Approve or reject a pending salary advance (RH). */
export async function decideAdvance(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "RH", "VALIDATE")) return { ok: false, error: "Non autorisé." };
  const id = fdStr(formData, "id");
  const decision = fdStr(formData, "decision"); // APPROVED | REJECTED
  if (!id || (decision !== "APPROVED" && decision !== "REJECTED")) {
    return { ok: false, error: "Paramètres manquants." };
  }
  const adv = await prisma.salaryAdvance.findUnique({ where: { id }, include: { employee: true } });
  if (!adv) return { ok: false, error: "Demande introuvable." };
  if (adv.status !== "PENDING") return { ok: false, error: "Cette demande a déjà été traitée." };

  // UN GESTE À LA FOIS : la décision ne s'écrit que sur une avance ENCORE en attente — un retrait par
  // le salarié (décision du 04/10) ou une décision croisée l'emportent, sans ordre de dépense en double.
  const pris = await prisma.salaryAdvance.updateMany({
    where: { id, status: "PENDING" },
    data: { status: decision, decidedById: user.id, decidedAt: new Date(), decisionNote: fdStr(formData, "note") },
  });
  if (pris.count === 0) return { ok: false, error: "Cette demande vient d'être traitée ou retirée — rechargez la page." };
  if (adv.employee.userId) {
    await prisma.notification.create({
      data: {
        userId: adv.employee.userId, type: "GENERIC",
        title: decision === "APPROVED" ? "Avance approuvée" : "Avance refusée",
        body: `Votre demande d'avance sur salaire a été ${decision === "APPROVED" ? "approuvée" : "refusée"}.`,
        link: LIEN_MES_AVANCES,
      },
    }).catch(() => undefined);
  }

  // Approval → emit an ordre de dépense for the comptable (who settles it).
  if (decision === "APPROVED") {
    await createExpenseOrder({
      label: `Avance sur salaire — ${adv.employee.fullName}`,
      amount: Number(adv.amount),
      category: "AVANCE",
      beneficiary: adv.employee.fullName,
      sourceType: "SALARY_ADVANCE",
      sourceId: id,
      requestedById: user.id,
    });
  }

  await recordAudit({
    actorId: user.id, action: decision === "APPROVED" ? "VALIDATE" : "REFUSE", module: "Ressources humaines",
    entityType: "SALARY_ADVANCE", entityId: id,
    summary: `Avance ${decision === "APPROVED" ? "approuvée" : "refusée"} — ${adv.employee.fullName}`,
  });
  revalidatePath("/rh");
  revalidatePath("/mon-espace");
  return { ok: true };
}

/** Cancel a still-pending advance (by its author or an RH manager). */
export async function cancelAdvance(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Demande introuvable." };
  const adv = await prisma.salaryAdvance.findUnique({ where: { id }, include: { employee: true } });
  if (!adv) return { ok: false, error: "Demande introuvable." };
  const isOwner = adv.employee.userId === user.id;
  const isRh = userCan(user, "RH", "UPDATE");
  if (!isOwner && !isRh) return { ok: false, error: "Non autorisé." };
  if (adv.status !== "PENDING") return { ok: false, error: "Seule une demande en attente peut être annulée." };

  // Conditionnelle : une décision des RH passée entre-temps l'emporte, et deux clics n'annulent qu'une fois.
  const pris = await prisma.salaryAdvance.updateMany({ where: { id, status: "PENDING" }, data: { status: "CANCELLED" } });
  if (pris.count === 0) return { ok: false, error: "Cette demande vient d'être traitée — rechargez la page." };
  // CEUX QUI DEVAIENT LA TRAITER SONT PRÉVENUS (décision du 04/10) : les RH quand le salarié la retire,
  // le salarié quand ce sont les RH.
  const corpsAvance = `${adv.employee.fullName} — avance de ${Number(adv.amount)} DZD : demande annulée${isOwner ? " par le salarié" : " par les RH"}.`;
  if (isOwner) {
    await notifyRoles(rolesWithModule("RH", "VALIDATE"), { type: "GENERIC", title: "Avance sur salaire annulée", body: corpsAvance, link: CHEMIN_PAIE_RH }).catch(() => undefined);
  } else if (adv.employee.userId) {
    await notifyUser({ userId: adv.employee.userId, type: "GENERIC", title: "Avance sur salaire annulée", body: corpsAvance, link: LIEN_MES_AVANCES }).catch(() => undefined);
  }
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Ressources humaines", entityType: "SALARY_ADVANCE",
    entityId: id, field: "status", oldValue: "PENDING", newValue: "CANCELLED", summary: `Avance annulée — ${adv.employee.fullName}`,
  });
  revalidatePath("/rh");
  revalidatePath("/mon-espace");
  return { ok: true };
}
