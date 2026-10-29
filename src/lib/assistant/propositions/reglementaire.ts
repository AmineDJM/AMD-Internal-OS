/**
 * PROPOSITIONS — Regulatory et réglages : champ d'un dossier, chargé, étape ANPP, réglage de
 * plateforme, rattachement en masse à une entité.
 * Une famille de l'ancienne chaîne de `buildProposal`, recopiée telle quelle et appelée à son rang
 * (voir `propositions/construire.ts`) ; elle rend `undefined` quand l'outil n'est pas le sien.
 */

import {
  prisma, companyScopedWhere, userCan, scopeRegulatory, canSetStructural, isRegStepKey, isRegStepState,
  isRegPresubOutcome, REG_STEPS, PRESUB_ANSWER_STEP, getAppSettings,
} from "@/lib/assistant/coeur/erp";
import { ROLE_LABELS, MODULE_LABELS } from "@/lib/labels";
import {
  WRITABLE_SETTINGS, parseSettingValue, parseRegFieldValue, regFieldSpec, settingSpec, renderSettingValue,
} from "@/lib/assistant/admin-write";
import { LIBELLES_COLONNES } from "@/lib/vues/colonnes-regulatory";
import type { ProposedAction } from "@/lib/assistant/coeur/contrat-actions";
import { asStr } from "@/lib/assistant/outils/arguments";
import { productBulkWhere, type ContexteProposition } from "@/lib/assistant/propositions/aides";

/** La famille « reglementaire » de `buildProposal` : rend `undefined` quand l'outil n'est pas le sien. */
export async function proposerReglementaire(c: ContexteProposition): Promise<ProposedAction | { error: string } | undefined> {
  const { toolName, input, user, warnings } = c;

  if (toolName === "update_regulatory_product") {
    if (!userCan(user, "REGULATORY", "UPDATE")) {
      return { error: "Vous n'avez pas le droit de modifier les dossiers Regulatory." };
    }
    const reference = asStr(input, "reference");
    const field = asStr(input, "field");
    if (!reference) return { error: "Précisez la référence du dossier (REG-AAAA-NNN)." };

    const spec = regFieldSpec(field);
    if (!spec) {
      return { error: `Champ « ${field } » inconnu ou non modifiable par l'assistant.` };
    }
    const parsed = parseRegFieldValue(field, input.value);
    if (!parsed.ok) return { error: parsed.error };

    // Le dossier est cherché DANS LE PÉRIMÈTRE de la personne : deviner une référence ne doit
    // pas permettre de modifier le portefeuille d'une autre entité.
    const product = await prisma.regulatoryProduct.findFirst({
      where: await companyScopedWhere(user.id, { AND: [{ reference }, scopeRegulatory(user)] }),
      select: { id: true, reference: true, dci: true, ...({ [field]: true } as Record<string, true>) },
    }) as (Record<string, unknown> & { id: string; reference: string; dci: string }) | null;
    if (!product) {
      return { error: `Dossier « ${reference} » introuvable dans votre périmètre. Vérifiez la référence avec search_products.` };
    }

    const before = renderSettingValue(product[field]);
    const after = renderSettingValue(parsed.value instanceof Date ? parsed.value.toISOString().slice(0, 10) : parsed.value);
    if (before === after) return { error: `« ${spec.label} » vaut déjà ${after || "(vide)"} sur ${reference}.` };
    if (spec.warning) warnings.push(spec.warning);

    return {
      kind: "update_regulatory_product",
      module: "REGULATORY",
      title: `modifier ${spec.label.toLowerCase()} sur ${reference}`,
      fields: [
        { label: "Dossier", value: `${reference} — ${product.dci}` },
        { label: spec.label, value: `${before || "(vide)"} → ${after || "(vide)"}` },
      ],
      warnings,
      payload: {
        kind: "update_regulatory_product",
        productId: product.id, reference: product.reference,
        field, fieldLabel: spec.label,
        value: parsed.value, before, after,
      },
    };
  }

  if (toolName === "assign_regulatory_responsible") {
    // LA MÊME PORTE QUE L'ÉCRAN : confier un dossier est un champ STRUCTUREL, réservé au
    // Super Admin — le refus est dit à la proposition, et l'action canonique re-refusera de
    // toute façon à l'exécution.
    if (!canSetStructural(user)) {
      return { error: "Seul le Super Admin désigne le chargé d'un dossier — la même règle que l'écran Regulatory." };
    }
    const reference = asStr(input, "reference");
    if (!reference) return { error: "Précisez la référence du dossier (REG-AAAA-NNN)." };
    const personName = asStr(input, "personName");

    const product = await prisma.regulatoryProduct.findFirst({
      where: await companyScopedWhere(user.id, { AND: [{ reference }, scopeRegulatory(user)] }),
      select: { id: true, reference: true, dci: true, responsible: { select: { id: true, name: true } } },
    });
    if (!product) return { error: `Dossier « ${reference} » introuvable dans votre périmètre.` };

    let responsibleId: string | null = null;
    let responsibleName: string | null = null;
    if (personName) {
      const people = await prisma.user.findMany({
        where: { isActive: true, name: { contains: personName, mode: "insensitive" } },
        select: { id: true, name: true },
        take: 5,
      });
      if (!people.length) return { error: `Aucune personne active « ${personName} » — vérifier avec search_people.` };
      if (people.length > 1) {
        return { error: `Plusieurs personnes correspondent à « ${personName} » : ${people.map((p) => p.name).join(", ")} — préciser le nom.` };
      }
      responsibleId = people[0].id;
      responsibleName = people[0].name;
    }
    const before = product.responsible?.name ?? "(personne)";
    if ((product.responsible?.id ?? null) === responsibleId) {
      return { error: `Le dossier ${reference} est déjà ${responsibleId ? `confié à ${responsibleName}` : "sans personne chargée"}.` };
    }

    return {
      kind: "assign_regulatory_responsible",
      module: "REGULATORY",
      title: responsibleName ? `confier ${reference} à ${responsibleName}` : `retirer le chargé du dossier ${reference}`,
      fields: [
        { label: "Dossier", value: `${product.reference} — ${product.dci}` },
        { label: "Chargé du dossier", value: `${before} → ${responsibleName ?? "(personne)"}` },
      ],
      warnings: [
        "La personne sera NOTIFIÉE (même circuit que l'écran) — c'est un engagement pris en son nom.",
        ...warnings,
      ],
      payload: {
        kind: "assign_regulatory_responsible",
        productId: product.id, reference: product.reference, dci: product.dci,
        responsibleId, responsibleName, before,
      },
    };
  }

  if (toolName === "set_regulatory_step") {
    if (!userCan(user, "REGULATORY", "UPDATE")) {
      return { error: "Vous n'avez pas le droit de modifier les dossiers Regulatory." };
    }
    const reference = asStr(input, "reference");
    const stepKey = asStr(input, "stepKey");
    if (!reference || !stepKey) return { error: "Précisez la référence du dossier et la clé de l'étape." };
    if (!isRegStepKey(stepKey)) return { error: `Étape « ${stepKey} » inconnue — utiliser les clés listées par l'outil.` };
    const status = asStr(input, "status") || null;
    const outcome = asStr(input, "outcome") || null;
    if (stepKey === PRESUB_ANSWER_STEP && !outcome && !status) {
      return { error: "La réponse de présoumission se règle par son AVIS (outcome : FAVORABLE / DEFAVORABLE / EN_ATTENTE)." };
    }
    if (outcome && stepKey !== PRESUB_ANSWER_STEP) {
      return { error: "L'avis (outcome) ne vaut que pour l'étape presub_ans — pour les autres, donner status." };
    }
    if (outcome && !isRegPresubOutcome(outcome)) return { error: "Avis invalide : FAVORABLE, DEFAVORABLE ou EN_ATTENTE." };
    if (!outcome && (!status || !isRegStepState(status))) return { error: "Statut invalide : TODO, DOING, DONE ou BLOCKED." };

    const product = await prisma.regulatoryProduct.findFirst({
      where: await companyScopedWhere(user.id, { AND: [{ reference }, scopeRegulatory(user)] }),
      select: { id: true, reference: true, dci: true },
    });
    if (!product) return { error: `Dossier « ${reference} » introuvable dans votre périmètre.` };

    const stepLabel = REG_STEPS.find((s) => s.key === stepKey)?.label ?? stepKey;
    return {
      kind: "set_regulatory_step",
      module: "REGULATORY",
      title: `étape « ${stepLabel} » de ${reference} → ${outcome ?? status}`,
      fields: [
        { label: "Dossier", value: `${product.reference} — ${product.dci}` },
        { label: "Étape", value: stepLabel },
        { label: outcome ? "Avis de présoumission" : "Statut", value: outcome ?? status ?? "" },
      ],
      warnings,
      payload: {
        kind: "set_regulatory_step",
        productId: product.id, reference: product.reference,
        stepKey, stepLabel,
        status, outcome,
        note: asStr(input, "note") || null,
        date: asStr(input, "date") || null,
      },
    };
  }

  if (toolName === "update_platform_setting") {
    // Les réglages gouvernent la plateforme entière : ils restent au Super Admin, exactement
    // comme la console d'administration d'où ils se règlent autrement.
    if (user.role !== "SUPER_ADMIN") return { error: "Les réglages de la plateforme sont réservés au Super Admin." };
    const key = asStr(input, "key");
    const spec = settingSpec(key);
    if (!spec) {
      return { error: `Réglage « ${key} » inconnu. Réglages modifiables : ${WRITABLE_SETTINGS.map((w) => `${w.key} (${w.label})`).join(", ")}.` };
    }
    const parsed = parseSettingValue(key, input.value, {
      roleLabels: ROLE_LABELS,
      moduleLabels: MODULE_LABELS as Record<string, string>,
    });
    if (!parsed.ok) return { error: parsed.error };

    const current = (await getAppSettings()) as unknown as Record<string, unknown>;
    const labels =
      spec.kind === "roles" ? ROLE_LABELS
      : spec.kind === "modules" ? (MODULE_LABELS as Record<string, string>)
      // Sans cette branche, la carte annoncerait « therapeuticClass » à quelqu'un qui vient de
      // dire « supprime la classe thérapeutique » — une confirmation qu'on donne sans avoir lu.
      : spec.kind === "regColumns" ? LIBELLES_COLONNES
      : {};
    const before = renderSettingValue(current[key], labels);
    const after = renderSettingValue(parsed.value, labels);
    if (before === after) return { error: `« ${spec.label} » vaut déjà ${after}.` };
    if (spec.warning) warnings.push(spec.warning);
    // Une liste REMPLACE : le dire, parce que « ajoute la Direction » et « mets la Direction »
    // s'écrivent pareil dans une conversation et ne veulent pas dire la même chose.
    if (Array.isArray(parsed.value)) warnings.push("Cette liste REMPLACE l'ancienne — elle ne s'y ajoute pas.");

    return {
      kind: "update_platform_setting",
      module: "ADMIN",
      level: "SENSITIVE",
      title: `modifier le réglage « ${spec.label} »`,
      fields: [
        { label: spec.label, value: `${before} → ${after}` },
        { label: "À propos", value: spec.hint },
      ],
      warnings,
      payload: {
        kind: "update_platform_setting",
        settingKey: key, settingLabel: spec.label,
        value: parsed.value, before, after,
      },
    };
  }

  if (toolName === "set_products_company") {
    // Écrire sur les dossiers réglementaires exige le droit de les MODIFIER, pas de les lire.
    if (!userCan(user, "REGULATORY", "UPDATE")) {
      return { error: "Vous n'avez pas le droit de modifier les dossiers Regulatory." };
    }
    const companyName = asStr(input, "companyName");
    if (!companyName) return { error: "Précisez l'entité de destination." };

    const companies = await prisma.company.findMany({
      where: { isActive: true },
      select: { id: true, name: true, shortName: true },
    });
    const needle = companyName.trim().toLowerCase();
    const matches = companies.filter(
      (c) => c.name.toLowerCase().includes(needle) || (c.shortName ?? "").toLowerCase().includes(needle),
    );
    if (matches.length === 0) {
      return { error: `Entité « ${companyName} » introuvable. Entités actives : ${companies.map((c) => c.shortName || c.name).join(", ") || "aucune"}.` };
    }
    if (matches.length > 1) {
      return { error: `Plusieurs entités correspondent à « ${companyName} » : ${matches.map((c) => c.name).join(", ")}. Précisez laquelle.` };
    }
    const company = matches[0];

    const query = asStr(input, "query");
    const category = asStr(input, "category");
    const onlyWithoutCompany = input.onlyWithoutCompany === true;
    const where = productBulkWhere(user, { query, category, onlyWithoutCompany, excludeCompanyId: company.id });

    const affected = await prisma.regulatoryProduct.findMany({
      where, select: { reference: true, dci: true, brandName: true }, orderBy: { reference: "asc" }, take: 400,
    });
    if (affected.length === 0) {
      return { error: `Aucun produit à rattacher : soit le filtre ne remonte rien, soit tous sont déjà rattachés à ${company.name}.` };
    }
    // La confirmation montre CE QUI change, pas un nombre : rattacher trente dossiers
    // réglementaires à la mauvaise entité se répare mal.
    const preview = affected.slice(0, 25).map((p) => `${p.reference} — ${p.brandName || p.dci}`);
    if (affected.length > preview.length) preview.push(`… et ${affected.length - preview.length} autre(s)`);
    if (affected.length >= 400) {
      warnings.push("Plus de 400 produits concernés : seuls les 400 premiers seront traités. Affinez le filtre.");
    }

    const fields = [
      { label: "Entité de destination", value: company.name },
      { label: "Produits concernés", value: String(affected.length) },
      { label: "Filtre", value: [query ? `« ${query} »` : "tout le portefeuille", category || null, onlyWithoutCompany ? "sans entité seulement" : null].filter(Boolean).join(" · ") },
      { label: "Détail", value: preview.join(" · ") },
    ];

    return {
      kind: "set_products_company",
      module: "REGULATORY",
      title: `Rattacher ${affected.length} produit(s) à l'entité ${company.shortName || company.name}`,
      fields,
      warnings,
      payload: {
        kind: "set_products_company",
        companyId: company.id,
        companyName: company.shortName || company.name,
        query: query || null,
        category: category || null,
        onlyWithoutCompany,
        references: affected.map((p) => p.reference),
      },
    };
  }

  return undefined;
}
