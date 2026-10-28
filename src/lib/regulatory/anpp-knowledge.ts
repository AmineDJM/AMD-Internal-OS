/**
 * BASE DE CONNAISSANCE RÉGLEMENTAIRE — Enregistrement des produits pharmaceutiques en ALGÉRIE (ANPP).
 *
 * Source de vérité UNIQUE et versionnée du logiciel pour tout ce qui touche à
 * l'enregistrement : tarifs (bordereaux de versement), délais légaux, pièces à fournir,
 * structure du dossier CTD (5 modules), pré-soumission, modifications post-enregistrement,
 * renouvellement, transfert/retrait, décision d'enregistrement.
 *
 * Fondée sur les textes officiels :
 *  - Décret exécutif n° 20-325 du 22 novembre 2020 (modalités d'enregistrement + commission).
 *  - Arrêté du 10 mai 2021 (composition du dossier d'enregistrement et de renouvellement).
 *  - Arrêté du 3 octobre 2021 (modalités de modification de la décision d'enregistrement).
 *  - Arrêté du 3 octobre 2021 (modèle du formulaire de pré-soumission).
 *  - Loi n° 18-11 du 2 juillet 2018 relative à la santé (art. 207-209, 218-219, 230).
 *
 * ⚠️ Outil d'AIDE À LA DÉCISION : prépare et vérifie pour le pharmacien directeur technique,
 * qui reste seul responsable de la validation finale et du dépôt auprès de l'ANPP.
 *
 * Alignement UE (CTD / eCTD ICH M4) : le format algérien reprend le CTD harmonisé
 * international (ICH). Les bonnes pratiques UE (BPF/GMP EudraLex Vol.4, RCP/SmPC, notice)
 * sont des références de forme utiles, mais la LOI ALGÉRIENNE PRIME toujours.
 */

export const REG_LEGAL_REFERENCES = [
  { code: "Décret exécutif n° 20-325", date: "22 novembre 2020", objet: "Modalités d'enregistrement des produits pharmaceutiques + commission d'enregistrement." },
  { code: "Arrêté (10 mai 2021)", date: "28 Ramadhan 1442", objet: "Composition du dossier d'enregistrement et du dossier de renouvellement (CTD)." },
  { code: "Arrêté (3 octobre 2021)", date: "26 Safar 1443", objet: "Modalités de modification de la décision d'enregistrement (mineure / modérée / majeure)." },
  { code: "Arrêté (3 octobre 2021)", date: "arrêté", objet: "Modèle du formulaire de demande de pré-soumission." },
  { code: "Loi n° 18-11", date: "2 juillet 2018", objet: "Loi relative à la santé (art. 207-209, 218-219, 230)." },
] as const;

/** Type de produit → assiette des droits d'enregistrement (bordereau de versement, DZD). */
export interface RegistrationFee {
  productType: string;
  presubmission: number; // 25 % — payé à la pré-soumission
  deposit: number; // 75 % — payé au dépôt du dossier
  total: number;
}

export const REGISTRATION_FEES: RegistrationFee[] = [
  { productType: "Non essentiel, importé", presubmission: 250_000, deposit: 750_000, total: 1_000_000 },
  { productType: "Essentiel, importé en l'état", presubmission: 150_000, deposit: 450_000, total: 600_000 },
  { productType: "Non essentiel, fabrication locale", presubmission: 37_500, deposit: 112_500, total: 150_000 },
  { productType: "Essentiel, fabrication locale", presubmission: 25_000, deposit: 75_000, total: 100_000 },
];

/** Autres droits (modification / transfert / renouvellement), en DZD. */
export const OTHER_FEES = [
  { operation: "Modification de la décision d'enregistrement", amount: 150_000 },
  { operation: "Transfert de décision d'enregistrement", amount: 100_000 },
  { operation: "Renouvellement", amount: 300_000 },
] as const;

export const FEE_SPECIAL_CASES = [
  "Ajout de nouvelles présentations : un B.V. pour la pré-soumission (25 %) puis deux B.V. pour le dépôt (75 %).",
  "Différents dosages et présentations : un B.V. par dosage, et un B.V. commun pour les différentes présentations.",
] as const;

/** Étapes du parcours d'enregistrement, avec délais légaux (jours) et base légale. */
export interface RegPhase {
  key: string;
  title: string;
  summary: string;
  legalDelays: string[];
  legalBasis: string;
}

export const REGISTRATION_PHASES: RegPhase[] = [
  {
    key: "BV",
    title: "I. Bordereau de versement (B.V.)",
    summary:
      "Obtenir le bordereau de versement auprès de l'ANPP via la plateforme E-TASDJIL, pour payer les droits. Le tarif dépend du type de demande (enregistrement, modification, transfert, renouvellement) et de la nature du produit (essentiel / non essentiel, importé / fabrication locale).",
    legalDelays: [],
    legalBasis: "Décret 20-325 art. 22 et 27 ; loi de finances.",
  },
  {
    key: "PRESUBMISSION",
    title: "II. Pré-soumission",
    summary:
      "Évaluation préliminaire par l'ANPP de l'intérêt thérapeutique ET économique du produit. Pièces : formulaire de demande de pré-soumission (modèle arrêté du 3 oct. 2021, signé par le pharmacien directeur technique) + Module 2 du CTD (produits importés) + quittance 25 % des droits. Avis favorable ⇒ 1 an pour déposer le dossier complet.",
    legalDelays: [
      "Recevabilité de la demande : 5 jours.",
      "Étude de l'intérêt thérapeutique et économique : 30 jours, prolongeable de 90 jours.",
      "Avis de la commission (si saisie) : 30 jours.",
      "Notification de la décision : 10 jours après avis / finalisation.",
      "Délai pour déposer ensuite le dossier complet : 1 an.",
    ],
    legalBasis: "Décret 20-325 art. 21-23 ; arrêté 3 oct. 2021 (formulaire).",
  },
  {
    key: "DEPOT",
    title: "III. Dépôt du dossier d'enregistrement complet",
    summary:
      "Dans un délai d'un an après acceptation de la pré-soumission (prolongeable de 90 j sur demande motivée). Dossier au format CTD (5 modules), conforme à l'arrêté du 10 mai 2021. Dépôt subordonné au versement des 75 % restants. L'ANPP peut demander des échantillons, réactifs et moyens de contrôle.",
    legalDelays: [
      "Dépôt : dans l'année suivant l'acceptation (+ 90 j sur demande motivée).",
      "Versement du complément de 75 % des droits à l'appui du dépôt.",
    ],
    legalBasis: "Décret 20-325 art. 24-27 ; arrêté 10 mai 2021.",
  },
  {
    key: "RECEVABILITE",
    title: "IV. Examen de recevabilité",
    summary:
      "Vérification que le dossier est complet, conforme, et que les droits sont acquittés. Dossier incomplet ⇒ irrecevable (notification + possibilité de compléter).",
    legalDelays: ["Recevabilité : 8 jours maximum après dépôt."],
    legalBasis: "Décret 20-325 art. 28.",
  },
  {
    key: "EVALUATION",
    title: "V. Évaluation technico-réglementaire",
    summary:
      "Évaluation approfondie de la qualité, la sécurité et l'efficacité (analyse documentaire des essais pharmaceutiques/précliniques/cliniques, stabilité, conformité BPF, analyse d'échantillons). Réserves communiquées à l'établissement, qui doit y répondre avant clôture.",
    legalDelays: [
      "Évaluation technique : 60 jours, prolongeable à 90 jours.",
      "Attestation de non-modification à fournir par le demandeur : 15 jours.",
    ],
    legalBasis: "Décret 20-325 art. 29-37.",
  },
  {
    key: "COMMISSION",
    title: "VI. Commission d'enregistrement + décision",
    summary:
      "Le dossier + rapports sont soumis à la commission d'enregistrement (experts désignés par arrêté). L'ANPP prend la décision finale après avis. Enregistrement accordé ⇒ décision valable 5 ans. Rejet ⇒ décision motivée, recours possible.",
    legalDelays: [
      "Avis de la commission : 30 jours (saisine), prorogeable de 30 jours si complément demandé.",
      "Transmission de l'avis au DG de l'ANPP : 8 jours après délibération.",
      "Décision de l'ANPP à compter de la recevabilité : ≤ 150 jours (prorogeable de 90 jours).",
      "Notification à l'établissement : 10 jours.",
      "Recours en cas de rejet : 30 jours après notification.",
    ],
    legalBasis: "Décret 20-325 art. 34-38, 41.",
  },
];

/** Pièces du dossier d'enregistrement complet (arrêté 10 mai 2021, art. 4). */
export const REGISTRATION_DOSSIER_PIECES = [
  "Nom/raison sociale et adresse de l'établissement demandeur, du pharmacien directeur technique et, le cas échéant, du fabricant.",
  "Dénomination commerciale du médicament.",
  "Composition qualitative et quantitative de tous les composants (avec DCI ou dénomination chimique).",
  "Évaluation des risques pour l'environnement, le cas échéant.",
  "Indications thérapeutiques, contre-indications et effets indésirables.",
  "Posologie, forme pharmaceutique, mode et voie d'administration, conditions et durée de conservation.",
  "Précautions d'emploi, mesures de sécurité (stockage, administration, élimination des déchets).",
  "Description du mode de fabrication.",
  "Description des méthodes de contrôle utilisées par le fabricant.",
  "Résultats des essais pharmaceutiques (physico-chimiques, biologiques/microbiologiques), non cliniques (toxico/pharmaco) et cliniques.",
  "RCP approuvé par l'autorité du pays d'origine + proposition de RCP (annexe I), maquettes de conditionnement primaire et secondaire, notice (annexe II) en arabe et en langue étrangère usitée en Algérie.",
  "AMM du pays d'origine + CPP (certificat de produit pharmaceutique) + CLV (certificat de libre vente) ou équivalent.",
  "Document attestant l'autorisation des intervenants (fabrication, essais) et la conformité BPF/BPL/BPC.",
  "Copie de toute AMM obtenue dans d'autres pays.",
  "Structure du prix du médicament.",
  "Désignation biothérapeutique / immunologique / radiopharmaceutique, le cas échéant.",
  "Bordereau de versement + quittance justifiant les 75 % restants des droits d'enregistrement.",
] as const;

/** Structure CTD — les 5 modules (format ICH harmonisé, obligatoire). */
export interface CtdModule {
  key: string;
  num: 1 | 2 | 3 | 4 | 5;
  title: string;
  description: string;
  /** Indices de classification (motifs de reconnaissance d'un fichier). */
  hints: string[];
}

export const CTD_MODULES: CtdModule[] = [
  {
    key: "M1", num: 1, title: "Module 1 — Données administratives",
    description: "Données administratives spécifiques (Algérie) : formulaires, autorisations, informations sur le produit et le prix, RCP/notice/étiquetage proposés, CPP/CLV/AMM d'origine.",
    hints: ["module 1", "m1", "administratif", "administrative", "cover", "application form", "rcp", "smpc", "notice", "etiquetage", "cpp", "clv", "amm", "prix"],
  },
  {
    key: "M2", num: 2, title: "Module 2 — Résumés (qualité, non clinique, clinique)",
    description: "Résumés et vue d'ensemble : résumé global de qualité (QOS), aperçu et résumés non cliniques, aperçu et résumés cliniques. C'est LE module exigé dès la pré-soumission (produits importés).",
    hints: ["module 2", "m2", "qos", "quality overall summary", "nonclinical overview", "clinical overview", "resume", "résumé", "summary"],
  },
  {
    key: "M3", num: 3, title: "Module 3 — Qualité (substance active + produit fini)",
    description: "Informations sur la qualité : substance(s) active(s) (S) et produit fini (P) — fabrication, contrôle, spécifications, stabilité, méthodes analytiques validées.",
    hints: ["module 3", "m3", "qualité", "quality", "drug substance", "drug product", "substance active", "produit fini", "stabilité", "stability", "specification", "spécification", "3.2.s", "3.2.p"],
  },
  {
    key: "M4", num: 4, title: "Module 4 — Rapports non cliniques",
    description: "Rapports d'études non cliniques : pharmacologie, pharmacocinétique, toxicologie.",
    hints: ["module 4", "m4", "non clinique", "nonclinical", "toxicolog", "pharmacolog", "pharmacokinetic", "études animales"],
  },
  {
    key: "M5", num: 5, title: "Module 5 — Rapports cliniques",
    description: "Rapports d'études cliniques : biodisponibilité/bioéquivalence (générique/biosimilaire obligatoire), efficacité, sécurité.",
    hints: ["module 5", "m5", "clinique", "clinical", "bioequivalence", "bioéquivalence", "bioavailability", "essai clinique", "study report", "csr"],
  },
];

export const CTD_RULES = [
  "Les 5 modules respectent STRICTEMENT le format, le contenu et le système de numérotation ICH (annexe III de l'arrêté du 10 mai 2021).",
  "Le format CTD s'applique à TOUTE demande : enregistrement, renouvellement ET modification.",
  "Applicable à tous les types : médicaments, biothérapeutiques, immunologiques, radiopharmaceutiques.",
  "Génériques et biothérapeutiques similaires : étude de bioéquivalence / d'équivalence thérapeutique OBLIGATOIRE (sauf exonération fixée par arrêté).",
  "Renouvellement : version consolidée en 2 modules (Module 1 administratif + Module 2 résumés) reprenant toutes les modifications depuis la décision ; l'ANPP peut exiger les 5 modules.",
] as const;

/** Modifications post-enregistrement (arrêté 3 oct. 2021). */
export const MODIFICATION_CATEGORIES = [
  { key: "MINEURE", label: "Modification mineure", def: "Répercussions minimales ou nulles sur la qualité, la sécurité ou l'efficacité.", delay: "Éléments + rapport soumis à la commission sous 30 jours (à compter de la recevabilité). Notification dans les 12 mois suivant la mise en œuvre (immédiate si surveillance continue requise)." },
  { key: "MODEREE", label: "Modification modérée", def: "Impact potentiel sur la qualité, la sécurité et l'efficacité.", delay: "Soumission à la commission sous 60 jours." },
  { key: "MAJEURE", label: "Modification majeure", def: "Répercussions significatives sur la qualité, la sécurité et l'efficacité.", delay: "Soumission à la commission sous 60 jours." },
  { key: "URGENTE_SECURITE", label: "Mesure de restriction urgente pour raison de sécurité", def: "Modification provisoire des informations produit rendue nécessaire par de nouvelles données de sécurité (indications, posologie, contre-indications, mises en garde, populations cibles).", delay: "Mise en œuvre immédiate puis régularisation." },
] as const;

export const MODIFICATION_RULES = [
  "Chaque demande de modification fait l'objet d'une soumission distincte ; regroupement possible dans les cas prévus (art. 9) — ex. modifications découlant d'une même modification modérée/majeure.",
  "Dépôt subordonné au versement d'une redevance par modification (quittance jointe).",
  "Recevabilité : 8 jours. Décision de l'ANPP : 10 jours après avis de la commission.",
  "Rejet motivé ⇒ demande amendée possible sous 30 jours ; l'ANPP se prononce sous 30 jours.",
  "Types selon les éléments modifiés : administratives, qualitatives, sécurité/efficacité/pharmacovigilance.",
] as const;

/** Mentions obligatoires de la décision d'enregistrement (décret 20-325 art. 40). */
export const DECISION_MENTIONS = [
  "Dénomination commerciale", "DCI", "Forme pharmaceutique et dosage", "Type de conditionnement et présentation",
  "Conditions et durée de conservation", "Nom et adresse du détenteur de la décision", "Nom et adresse de l'exploitant",
  "Nom et adresse des intervenants dans la fabrication (produit fini, intermédiaires, conditionnements, libération des lots)",
  "Liste et affectation du produit (hospitalier et/ou officine)",
  "Le cas échéant : mesures restrictives, annexes RCP + notice patient approuvés.",
] as const;

export const DECISION_RULES = [
  "Validité de la décision : 5 ans à compter de la signature.",
  "Renouvellement : demande + dossier déposés 180 jours avant l'expiration.",
  "Non mise sur le marché ou export dans les 18 mois suivant la notification ⇒ l'ANPP peut retirer la décision.",
  "Détenteur/exploitant : obligation de déclarer immédiatement toute modification (origine/qualité substance active, rapport bénéfice/risque, RCP/notice, méthodes de fabrication/contrôle, interdictions/restrictions d'un autre pays).",
  "Retrait temporaire ⇒ définitif après 12 mois si les réserves ne sont pas levées.",
  "Transfert / cession ⇒ nouvelle décision d'enregistrement (établissement agréé) ; l'ancienne reste en vigueur jusqu'à l'établissement de la nouvelle.",
] as const;

/** Motifs de refus d'enregistrement (décret 20-325 art. 38). */
export const REFUSAL_GROUNDS = [
  "Produit nocif dans les conditions normales d'emploi prévues.",
  "Effet thérapeutique insuffisamment démontré.",
  "Composition qualitative/quantitative non conforme au dossier.",
  "Procédés de fabrication et/ou de contrôle ne garantissant pas qualité, efficacité, sécurité.",
  "Documentation/renseignements non conformes aux exigences du décret.",
  "Évaluation médico-économique défavorable.",
] as const;

/**
 * Digest COMPACT (texte) injecté dans le contexte du bot Regulatory pour qu'il maîtrise
 * parfaitement le cadre légal algérien de l'enregistrement — sans jamais inventer.
 */
export function regulatoryKnowledgeDigest(): string {
  const fees = REGISTRATION_FEES.map((f) => `  • ${f.productType} : total ${f.total.toLocaleString("fr-FR")} DZD (pré-soumission ${f.presubmission.toLocaleString("fr-FR")} = 25 % ; dépôt ${f.deposit.toLocaleString("fr-FR")} = 75 %).`).join("\n");
  const other = OTHER_FEES.map((o) => `  • ${o.operation} : ${o.amount.toLocaleString("fr-FR")} DZD.`).join("\n");
  const phases = REGISTRATION_PHASES.map((p) => `- ${p.title} — ${p.summary}${p.legalDelays.length ? ` Délais : ${p.legalDelays.join(" ")}` : ""}`).join("\n");
  const ctd = CTD_MODULES.map((m) => `  • ${m.title} : ${m.description}`).join("\n");
  const mods = MODIFICATION_CATEGORIES.map((m) => `  • ${m.label} — ${m.def} (${m.delay})`).join("\n");
  return [
    "EXPERTISE RÉGLEMENTAIRE — ENREGISTREMENT DES PRODUITS PHARMACEUTIQUES EN ALGÉRIE (ANPP).",
    "Tu maîtrises PARFAITEMENT le cadre ci-dessous et tu réponds en citant les articles/arrêtés. Tu ne remplaces pas le pharmacien directeur technique : tu prépares, tu vérifies, tu alertes ; la validation finale lui revient.",
    "Textes : Décret exécutif 20-325 (22/11/2020), Arrêté du 10/05/2021 (dossier CTD), Arrêté du 03/10/2021 (modifications + formulaire pré-soumission), Loi 18-11 (santé).",
    "",
    "DROITS D'ENREGISTREMENT (bordereau de versement, E-TASDJIL) :",
    fees,
    "Autres droits :",
    other,
    `Cas particuliers : ${FEE_SPECIAL_CASES.join(" ")}`,
    "",
    "PARCOURS ET DÉLAIS LÉGAUX :",
    phases,
    "",
    "DOSSIER AU FORMAT CTD (5 modules, numérotation ICH stricte) :",
    ctd,
    `Règles CTD : ${CTD_RULES.join(" ")}`,
    "",
    "PRÉ-SOUMISSION : formulaire officiel (signé par le pharmacien directeur technique) + Module 2 du CTD (produits importés) + quittance 25 %. L'ANPP évalue l'intérêt thérapeutique ET économique. Avis favorable ⇒ 1 an pour déposer le dossier complet.",
    "",
    "MODIFICATIONS POST-ENREGISTREMENT :",
    mods,
    "",
    `DÉCISION D'ENREGISTREMENT : ${DECISION_RULES.join(" ")}`,
    `MOTIFS DE REFUS (art. 38) : ${REFUSAL_GROUNDS.join(" ")}`,
    "",
    "Alignement CTD/eCTD ICH M4 identique à l'UE ; les bonnes pratiques UE (BPF EudraLex Vol.4, RCP/SmPC) sont des références de forme, mais la LOI ALGÉRIENNE PRIME.",
  ].join("\n");
}
