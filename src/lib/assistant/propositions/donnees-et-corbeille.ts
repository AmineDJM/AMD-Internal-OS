/**
 * PROPOSITIONS — Référentiels et corbeille : établissements, salaire, suppression / restauration /
 * purge, relance de trésorerie.
 * Une famille de l'ancienne chaîne de `buildProposal`, recopiée telle quelle et appelée à son rang
 * (voir `propositions/construire.ts`) ; elle rend `undefined` quand l'outil n'est pas le sien.
 */

import {
  prisma, userCan, peutAnnuaire, DELETE_REGISTRY, DELETABLE_KINDS, apercuSuppression, isDeletableKind,
} from "@/lib/assistant/coeur/erp";
import { resolveDeletableTarget, resolveTrashEntry } from "@/lib/assistant/delete-resolve";
import { toNumber, formatMontant } from "@/lib/utils";
import type { AssistantActionPayload, ProposedAction } from "@/lib/assistant/coeur/contrat-actions";
import { asStr } from "@/platform/ia/outils/arguments";
import type { ContexteProposition } from "@/lib/assistant/propositions/aides";

/** La famille « donnees-et-corbeille » de `buildProposal` : rend `undefined` quand l'outil n'est pas le sien. */
export async function proposerDonneesEtCorbeille(c: ContexteProposition): Promise<ProposedAction | { error: string } | undefined> {
  const { toolName, input, user, warnings } = c;

  if (toolName === "create_hospital") {
    const name = asStr(input, "name");
    if (!name) return { error: "Le nom de l'hôpital est obligatoire." };
    const registre = asStr(input, "registre").toUpperCase() === "ANNUAIRE" ? "ANNUAIRE" : "STOCKS";

    if (registre === "STOCKS") {
      // La liste des lieux de stock est tenue par le Super Admin — la même règle que l'écran.
      if (user.role !== "SUPER_ADMIN") return { error: "Seul le Super Admin ajoute un lieu à la liste des stocks. Pour l'annuaire médical, utiliser registre=ANNUAIRE." };
      const kind = asStr(input, "kind").toUpperCase() === "ANNEX" ? "ANNEX" : "HOSPITAL";
      const existing = await prisma.stockAnnex.findFirst({ where: { name: { equals: name, mode: "insensitive" } } });
      if (existing) return { error: `« ${existing.name} » existe déjà dans les lieux de stock.` };
      // UN HÔPITAL DE STOCK EST UN ÉTABLISSEMENT DE L'ANNUAIRE (§118.134) : on le désigne, on ne
      // le retape pas. Absent de l'annuaire → le remède est nommé (registre=ANNUAIRE d'abord).
      let institutionId: string | null = null;
      if (kind === "HOSPITAL") {
        const etabs = await prisma.medicalInstitution.findMany({
          where: { name: { equals: name, mode: "insensitive" }, isActive: true }, select: { id: true, name: true, wilaya: true }, take: 3,
        });
        if (etabs.length === 0) return { error: `« ${name} » n'est pas dans l'annuaire des établissements. Les hôpitaux du module Stocks sont ceux de l'annuaire : créez-le d'abord avec registre=ANNUAIRE, puis ajoutez-le aux stocks.` };
        if (etabs.length > 1) return { error: `Plusieurs établissements s'appellent « ${name} » (${etabs.map((e) => e.wilaya ?? "wilaya inconnue").join(", ")}) : précisez lequel ajouter aux stocks.` };
        institutionId = etabs[0].id;
      }
      return {
        kind: "create_hospital", module: "STOCKS", title: `Ajouter ${kind === "ANNEX" ? "une annexe PCH" : "un hôpital de l'annuaire"} aux stocks`, warnings,
        fields: [
          { label: "Nom", value: name },
          { label: "Nature", value: kind === "ANNEX" ? "Annexe PCH" : "Hôpital (établissement de l'annuaire)" },
          { label: "Registre", value: "Lieux de stock (module Stocks)" },
        ],
        payload: { kind: "create_hospital", registre: "STOCKS", name, annexKind: kind, institutionId },
      };
    }

    // LA PORTE DE L'ANNUAIRE, pas celle du module (§118.147) : la même règle que l'écran et que
    // l'action `createInstitution` — un accès ouvert depuis la console suffit. Refuser ici ce que
    // l'écran accepte serait un « je ne peux pas » écrit dans le code (§118.63).
    if (!peutAnnuaire(user, "ETABLISSEMENTS", "CREATE")) return { error: "Vous n'avez pas le droit d'ajouter un établissement à l'annuaire (Promotion médicale, ou accès ouvert depuis Administration › Comptes)." };
    const dupe = await prisma.medicalInstitution.findFirst({ where: { name: { equals: name, mode: "insensitive" } }, select: { name: true } });
    if (dupe) warnings.push(`Un établissement « ${dupe.name} » existe déjà dans l'annuaire — vérifier qu'il ne s'agit pas d'un doublon.`);
    const fields = [
      { label: "Nom", value: name },
      { label: "Registre", value: "Annuaire médical (établissements)" },
    ];
    if (asStr(input, "type")) fields.push({ label: "Type", value: asStr(input, "type") });
    if (asStr(input, "sector")) fields.push({ label: "Secteur", value: asStr(input, "sector") });
    const place = [asStr(input, "city"), asStr(input, "wilaya")].filter(Boolean).join(", ");
    if (place) fields.push({ label: "Lieu", value: place });
    return {
      kind: "create_hospital", module: "MEDICAL", title: "Ajouter un établissement à l'annuaire", fields, warnings,
      payload: {
        kind: "create_hospital", registre: "ANNUAIRE", name,
        institutionType: asStr(input, "type") || null, sector: asStr(input, "sector") || null,
        wilaya: asStr(input, "wilaya") || null, city: asStr(input, "city") || null,
      },
    };
  }

  if (toolName === "update_hospital") {
    if (!peutAnnuaire(user, "ETABLISSEMENTS", "UPDATE")) return { error: "Vous n'avez pas le droit de modifier l'annuaire des établissements (Promotion médicale, ou accès ouvert depuis Administration › Comptes)." };
    const needle = asStr(input, "name");
    if (needle.length < 2) return { error: "Donnez le nom (fragment) de l'établissement." };
    const inst = await prisma.medicalInstitution.findFirst({
      where: { name: { contains: needle, mode: "insensitive" } },
      select: { id: true, name: true, type: true, sector: true, wilaya: true, city: true, phone: true, email: true, isActive: true },
    });
    if (!inst) return { error: `Aucun établissement « ${needle} » dans l'annuaire.` };

    const updates: Extract<AssistantActionPayload, { kind: "update_hospital" }>["updates"] = {};
    const changes: string[] = [];
    const fields: { label: string; value: string }[] = [{ label: "Établissement", value: inst.name }];
    const push = (label: string, before: string, after: string) => {
      fields.push({ label, value: `${before || "(vide)"} → ${after || "(vide)"}` });
      changes.push(label);
    };
    if (asStr(input, "newName")) { updates.newName = asStr(input, "newName"); push("Nom", inst.name, updates.newName); }
    if (asStr(input, "type")) { updates.type = asStr(input, "type").toUpperCase(); push("Type", inst.type, updates.type); }
    if (asStr(input, "sector")) { updates.sector = asStr(input, "sector").toUpperCase(); push("Secteur", inst.sector, updates.sector); }
    if (asStr(input, "wilaya")) { updates.wilaya = asStr(input, "wilaya"); push("Wilaya", inst.wilaya ?? "", updates.wilaya); }
    if (asStr(input, "city")) { updates.city = asStr(input, "city"); push("Ville", inst.city ?? "", updates.city); }
    if (asStr(input, "phone")) { updates.phone = asStr(input, "phone"); push("Téléphone", inst.phone ?? "", updates.phone); }
    if (asStr(input, "email")) { updates.email = asStr(input, "email"); push("E-mail", inst.email ?? "", updates.email); }
    if (asStr(input, "notes")) { updates.notes = asStr(input, "notes"); changes.push("Notes"); fields.push({ label: "Notes", value: updates.notes }); }
    if (typeof input.active === "boolean") { updates.isActive = input.active; push("Actif", inst.isActive ? "oui" : "non", input.active ? "oui" : "non"); }
    if (changes.length === 0) return { error: "Aucun changement demandé — précisez quoi modifier." };

    return {
      kind: "update_hospital", module: "MEDICAL", title: `Modifier « ${inst.name} »`, fields, warnings,
      payload: { kind: "update_hospital", institutionId: inst.id, name: inst.name, updates, changes },
    };
  }

  if (toolName === "update_salary") {
    // La même porte que la paie RH (`canRunPayroll`) : le droit de MODIFIER le module RH.
    if (!userCan(user, "RH", "UPDATE")) return { error: "La modification des salaires est réservée aux détenteurs du droit RH (modification)." };
    const name = asStr(input, "employee_name");
    if (name.length < 2) return { error: "Donnez le nom de l'employé." };
    const emp = await prisma.employee.findFirst({
      where: { fullName: { contains: name, mode: "insensitive" }, isActive: true },
      select: { id: true, fullName: true, position: true, baseSalary: true, netToPay: true, grossSalary: true, employerCost: true },
    });
    if (!emp) return { error: `Aucun employé actif « ${name} » dans le registre RH.` };

    const SALARY_FIELDS = [
      { key: "base_salary", field: "baseSalary" as const, label: "Salaire de base", before: toNumber(emp.baseSalary) },
      { key: "net_to_pay", field: "netToPay" as const, label: "Net à payer", before: emp.netToPay != null ? toNumber(emp.netToPay) : null },
      { key: "gross_salary", field: "grossSalary" as const, label: "Salaire brut", before: emp.grossSalary != null ? toNumber(emp.grossSalary) : null },
      { key: "employer_cost", field: "employerCost" as const, label: "Coût employeur", before: emp.employerCost != null ? toNumber(emp.employerCost) : null },
    ];
    const fields: { label: string; value: string }[] = [{ label: "Employé", value: `${emp.fullName}${emp.position ? ` — ${emp.position}` : ""}` }];
    const changed: Extract<AssistantActionPayload, { kind: "update_salary" }>["fields"] = [];
    for (const s of SALARY_FIELDS) {
      const v = input[s.key];
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      if (v <= 0) return { error: `${s.label} : le montant doit être positif.` };
      const after = Math.round(v * 100) / 100;
      const pct = s.before != null && s.before > 0 ? Math.round(((after - s.before) / s.before) * 1000) / 10 : null;
      changed.push({ field: s.field, label: s.label, before: s.before != null ? Math.round(s.before * 100) / 100 : null, after });
      fields.push({
        label: s.label,
        value: `${s.before != null ? formatMontant(s.before) : "(non renseigné)"} → ${formatMontant(after)} DZD`
          + (pct != null ? ` (écart ${pct > 0 ? "+" : ""}${pct.toLocaleString("fr-FR")} %)` : ""),
      });
    }
    if (changed.length === 0) return { error: "Aucun montant fourni — donnez au moins un montant (base_salary, net_to_pay, gross_salary ou employer_cost). Lire d'abord read_payroll." };
    const note = asStr(input, "note") || null;
    if (note) fields.push({ label: "Motif / effet", value: note });
    warnings.push("NIVEAU CRITIQUE : cette modification change la rémunération sur la fiche RH. La confirmation exige la re-saisie du nouveau montant.");
    warnings.push("La fiche change ; la paie du mois se saisit toujours dans RH → Paie (la ligne du mois en cours n'est pas réécrite).");

    return {
      kind: "update_salary", module: "RH", title: `Modifier le salaire de ${emp.fullName}`, fields, warnings,
      level: "CRITICAL",
      confirmText: String(changed[0].after),
      payload: { kind: "update_salary", employeeId: emp.id, employeeName: emp.fullName, fields: changed, note },
    };
  }

  if (toolName === "delete_record") {
    // LA MÊME PORTE QUE L'ÉCRAN : le bouton « Supprimer définitivement » n'existe que pour le
    // Super Admin — le refus est dit à la proposition, et `superAdminDelete` re-refusera de
    // toute façon à l'exécution.
    if (user.role !== "SUPER_ADMIN") {
      return { error: "La suppression définitive est réservée au Super Admin — la même règle que le bouton rouge des fiches." };
    }
    const rawKind = asStr(input, "kind");
    if (!isDeletableKind(rawKind)) {
      return { error: `Type « ${rawKind} » non supprimable. Types possibles : ${DELETABLE_KINDS.join(", ")}.` };
    }
    const query = asStr(input, "reference");
    if (!query) return { error: "Précisez la référence, le nom ou l'id de l'élément à supprimer." };

    const spec = DELETE_REGISTRY[rawKind];
    const target = await resolveDeletableTarget(rawKind, query);
    if (target.status === "none") {
      return { error: `Aucun élément « ${spec.label} » trouvé pour « ${query} ». Vérifier la référence (ou donner l'id interne visible dans le lien de la fiche).` };
    }
    if (target.status === "ambiguous") {
      return { error: `Plusieurs éléments « ${spec.label} » correspondent à « ${query} » : ${target.candidates.map((c) => c.name).join(" ; ")} — donner la référence exacte.` };
    }

    // CE QUE CE TYPE REFUSE, lu AVANT de construire la carte : un identifiant interne exact
    // résout n'importe quel élément (`resolveDeletableTarget`, chemin 1), y compris un que le
    // registre refuse. Sans cette porte, Adam proposait le geste, la personne le confirmait, et
    // l'exécution le refusait — une garde se place AVANT, jamais après le clic (§118.83).
    // L'APERÇU porte ce refus ET ce qui partirait avec l'élément (§118.162) — le même que lit la
    // fenêtre de l'écran : deux rédactions de « ce qui part avec » diraient deux choses (§118.5).
    const apercu = await apercuSuppression(rawKind, target.id);
    if (apercu.refus) return { error: apercu.refus };

    // La référence à RESSAISIR pour armer la confirmation : la partie référence du nom affiché
    // (« REG-2026-041 — FOSFOMYCINE » → « REG-2026-041 »), ou le nom entier s'il n'y en a pas.
    const confirmText = target.name.includes(" — ") ? target.name.split(" — ")[0] : target.name;
    return {
      kind: "delete_record",
      module: "ADMIN",
      level: "CRITICAL",
      confirmText,
      title: `SUPPRIMER définitivement « ${target.name} »`,
      fields: [
        { label: "Élément", value: target.name },
        { label: "Type", value: `${spec.label} (module ${spec.module})` },
        { label: "Impact", value: "L'élément, ses pièces jointes et ses commentaires disparaissent de tous les écrans." },
        ...(apercu.lot && apercu.emporte.length ? [{ label: "Part aussi", value: apercu.emporte.join(", ") }] : []),
        // Ce qui RESTE mais perd son lien — le même aperçu que la fenêtre de l'écran (§118.163).
        ...(apercu.lot && apercu.detache.length ? [{ label: "Perd son lien", value: apercu.detache.join(", ") }] : []),
      ],
      warnings: [
        `NIVEAU CRITIQUE : même suppression que le bouton rouge de la fiche — la confirmation exige de RESSAISIR « ${confirmText} ».`,
        "Un instantané est déposé dans la corbeille (Administration → Corbeille) : le Super Admin peut restaurer l'élément, ses pièces jointes et ses commentaires.",
        apercu.lot
          ? "Ce qui part avec lui revient avec lui si le Super Admin le restaure."
          : "Les lignes liées supprimées en cascade (enfants du schéma) ne sont PAS restaurables.",
        // La réserve PROPRE à ce type, quand la cascade emporte le contenu même de l'objet.
        ...(spec.reserve ? [spec.reserve] : []),
        ...warnings,
      ],
      payload: {
        kind: "delete_record",
        deleteKind: rawKind, targetId: target.id, name: target.name,
        label: spec.label, redirect: spec.redirect,
      },
    };
  }

  if (toolName === "restore_record" || toolName === "purge_record") {
    // LA MÊME PORTE QUE L'ÉCRAN Administration → Corbeille : Super Admin uniquement — et les
    // actions canoniques re-refuseront de toute façon à l'exécution.
    if (user.role !== "SUPER_ADMIN") {
      return { error: "La corbeille (restauration / destruction) est réservée au Super Admin." };
    }
    const query = asStr(input, "name");
    if (!query) return { error: "Précisez le nom de l'élément tel qu'affiché dans la corbeille." };
    const rawKind = asStr(input, "kind");
    if (rawKind && !isDeletableKind(rawKind)) {
      return { error: `Type « ${rawKind} » inconnu. Types possibles : ${DELETABLE_KINDS.join(", ")}.` };
    }
    const forRestore = toolName === "restore_record";
    const entry = await resolveTrashEntry(query, rawKind && isDeletableKind(rawKind) ? rawKind : null, { forRestore });
    if (entry.status === "none") {
      return { error: `Aucune entrée de corbeille ${forRestore ? "restaurable" : ""} trouvée pour « ${query} »${rawKind ? ` (type ${rawKind})` : ""}.` };
    }
    if (entry.status === "ambiguous") {
      return { error: `Plusieurs entrées de corbeille correspondent à « ${query} » : ${entry.candidates.map((c) => `${c.name} (${c.label})`).join(" ; ")} — préciser le nom exact ou le type (kind).` };
    }

    if (forRestore) {
      // UN LOT (§118.162) revient avec ses branches : la carte le dit, au lieu d'annoncer que
      // « les éléments liés ne reviennent pas » — faux pour une demande Ad & Pro.
      const rec = await prisma.deletedRecord.findUnique({ where: { id: entry.recordId }, select: { lot: true } });
      const lot = rec?.lot && typeof rec.lot === "object" ? (rec.lot as { resume?: unknown }) : null;
      const revient = lot && Array.isArray(lot.resume) ? lot.resume.filter((x): x is string => typeof x === "string") : [];
      return {
        kind: "restore_record",
        module: "ADMIN",
        title: `Restaurer « ${entry.name} » depuis la corbeille`,
        fields: [
          { label: "Élément", value: entry.name },
          { label: "Type", value: entry.label },
          { label: "Effet", value: "Recréé à l'identique (mêmes id/référence) avec ses pièces jointes et commentaires." },
          ...(revient.length ? [{ label: "Revient avec lui", value: revient.join(", ") }] : []),
        ],
        warnings: [lot
          ? "Tout ce qui était parti avec lui revient avec lui — ou rien ne revient, si un élément lié manque."
          : "Les éléments liés qui avaient été supprimés en cascade ne reviennent pas."],
        payload: { kind: "restore_record", recordId: entry.recordId, name: entry.name, label: entry.label },
      };
    }

    const confirmText = entry.name.includes(" — ") ? entry.name.split(" — ")[0] : entry.name;
    return {
      kind: "purge_record",
      module: "ADMIN",
      level: "CRITICAL",
      confirmText,
      title: `DÉTRUIRE définitivement « ${entry.name} » (corbeille)`,
      fields: [
        { label: "Élément", value: entry.name },
        { label: "Type", value: entry.label },
        { label: "Impact", value: "Les fichiers stockés sont EFFACÉS. Aucun retour possible — contrairement à la suppression simple, rien ne reste restaurable." },
      ],
      warnings: [
        `NIVEAU CRITIQUE : destruction RÉELLE — la confirmation exige de RESSAISIR « ${confirmText} ».`,
        ...(entry.restored ? ["Cette entrée a déjà été RESTAURÉE : la destruction n'efface que l'entrée d'historique, les fichiers restaurés restent en place."] : []),
      ],
      payload: { kind: "purge_record", recordId: entry.recordId, name: entry.name, label: entry.label },
    };
  }

  if (toolName === "request_treasury_update") {
    // LA MÊME PORTE QUE LE BOUTON « Banque & paiements » — et il est réservé au SUPER ADMIN :
    // le geste sonne chez tous les responsables Finances, ouvert plus largement il devient une
    // sonnerie que personne n'écoute plus. Revérifié par l'action canonique à l'exécution.
    if (user.role !== "SUPER_ADMIN") {
      return { error: "La demande d'actualisation des soldes est réservée au Super Admin (même règle que le bouton « Banque & paiements »)." };
    }
    const note = asStr(input, "note") || null;
    const fields = [
      { label: "Action native", value: "Finances — « Demander l'actualisation des soldes »" },
      { label: "Destinataires", value: "Responsables Finances (+ Super Admin) — notification avec lien vers la Comptabilité" },
    ];
    if (note) fields.push({ label: "Précision", value: note });
    return {
      kind: "request_treasury_update",
      module: "FINANCES",
      title: "Demander l'actualisation des soldes",
      fields,
      warnings: ["Relance traçable (auditée) : les soldes ne sont PAS modifiés — les Finances les mettent à jour depuis « Soldes d'ouverture ».", ...warnings],
      payload: { kind: "request_treasury_update", note },
    };
  }

  return undefined;
}
