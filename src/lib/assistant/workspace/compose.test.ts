import { describe, it, expect } from "vitest";
import { composeWorkspace, tableFromRows, COMPOSABLE_TOOLS } from "./compose";
import { WORKSPACE_LIMITS } from "@/platform/ia/workspace/protocol";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CE QUI A LE DROIT D'ARRIVER À L'ÉCRAN.
 *
 * Le premier groupe vérifie que la donnée canonique se rend bien. Le second — le plus
 * important — vérifie qu'une forme INCONNUE ne rend RIEN. C'est par là que six lignes de
 * salaire sont un jour arrivées à l'écran en réponse à « Bonsoir, ça va ? » : un affichage
 * capable de tout montrer finit par tout montrer.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const J = (v: unknown) => JSON.stringify(v);

describe("l'annuaire — une personne", () => {
  const raw = J({
    personnes: [{
      nom: "Raihana Bensalem",
      poste: "Pharmacienne responsable",
      entite: "Adventum",
      coordonnees: [
        { canal: "e-mail", valeur: "r.bensalem@adventum.dz", usage: "professionnel", fiabilite: "vérifiée en interne", principale: true },
        { canal: "téléphone", valeur: "+213 555 00 11 22", fiabilite: "compte / fiche ERP" },
      ],
    }],
    note: "Pour écrire, préférer une coordonnée vérifiée.",
  });

  it("compose une fiche de contact", () => {
    const c = composeWorkspace("directory_lookup", raw);
    expect(c?.source).toBe("directory_lookup");
    expect(c?.blocks).toHaveLength(1);
    const b = c!.blocks[0];
    expect(b.kind).toBe("people");
    if (b.kind !== "people") return;
    expect(b.title).toBe("Raihana Bensalem");
    expect(b.people[0].coordonnees).toHaveLength(2);
    expect(b.people[0].coordonnees[0].canal).toBe("e-mail");
    expect(b.people[0].coordonnees[1].canal).toBe("téléphone");
  });

  it("garde la PROVENANCE de chaque coordonnée", () => {
    // Une adresse « déduite » présentée comme un fait, c'est un contrat envoyé à la mauvaise
    // personne. La fiabilité doit traverser jusqu'au rendu.
    const b = composeWorkspace("directory_lookup", raw)!.blocks[0];
    if (b.kind !== "people") throw new Error("bloc inattendu");
    expect(b.people[0].coordonnees[0].fiabilite).toBe("vérifiée en interne");
    expect(b.people[0].coordonnees[0].principale).toBe(true);
  });

  it("« personne introuvable » n'est pas un tableau vide — c'est une phrase", () => {
    const c = composeWorkspace("directory_lookup", J({ resultat: "personne introuvable", precision: "Aucune entrée." }));
    expect(c).toBeNull();
  });
});

describe("l'annuaire — le registre", () => {
  const rows = Array.from({ length: 120 }, (_, i) => ({
    nom: `Salarié ${i}`,
    poste: "Poste",
    departement: "Réglementaire",
    entite: "Adventum",
    emails: [{ adresse: `s${i}@adventum.dz`, usage: "fiche ERP", fiabilite: "compte / fiche ERP" }],
    telephones: i % 2 === 0 ? ["+213 555 000 000"] : undefined,
  }));

  it("compose le registre avec son total réel", () => {
    const c = composeWorkspace("directory_list", J({ total: 120, salaries: rows, note: "Source : registre RH." }));
    const b = c!.blocks[0];
    expect(b.kind).toBe("directory");
    if (b.kind !== "directory") return;
    expect(b.total).toBe(120);
    expect(b.note).toContain("registre RH");
  });

  it("TRONQUE — un tableau de 120 lignes dans une conversation est un vidage, pas un espace de travail", () => {
    const c = composeWorkspace("directory_list", J({ total: 120, salaries: rows }));
    const b = c!.blocks[0];
    if (b.kind !== "directory") throw new Error("bloc inattendu");
    expect(b.rows).toHaveLength(WORKSPACE_LIMITS.tableRows);
    // Le total reste VRAI : c'est lui qui permet au rendu de dire combien manquent.
    expect(b.total).toBeGreaterThan(b.rows.length);
  });

  it("réunit adresses et téléphones sur la même ligne", () => {
    const c = composeWorkspace("directory_list", J({ total: 1, salaries: [rows[0]] }));
    const b = c!.blocks[0];
    if (b.kind !== "directory") throw new Error("bloc inattendu");
    expect(b.rows[0].coordonnees.map((e) => e.canal)).toEqual(["e-mail", "téléphone"]);
  });

  it("un salarié sans aucune coordonnée reste dans la liste", () => {
    // Le supprimer donnerait un effectif faux. Son absence de coordonnée EST l'information.
    const c = composeWorkspace("directory_list", J({ total: 1, salaries: [{ nom: "Sans contact", emails: [] }] }));
    const b = c!.blocks[0];
    if (b.kind !== "directory") throw new Error("bloc inattendu");
    expect(b.rows).toHaveLength(1);
    expect(b.rows[0].coordonnees).toHaveLength(0);
  });
});

describe("les messages", () => {
  const raw = J({
    messages: [{
      id: "m1", filId: "t1", de: "Deepak Sharma <deepak@fournisseur.in>",
      objet: "Stabilité — lot 4471", recuLe: "hier 14:02", importance: "HIGH",
      extrait: "x".repeat(600),
      demandes: ["confirmer la date d'expédition"],
      piecesJointes: ["stabilite.pdf"],
      alerteManipulation: ["consigne intégrée au message"],
    }],
  });

  it("compose la liste et écourte l'extrait", () => {
    const b = composeWorkspace("gmail_search", raw)!.blocks[0];
    expect(b.kind).toBe("mail");
    if (b.kind !== "mail") return;
    expect(b.messages[0].objet).toBe("Stabilité — lot 4471");
    expect(b.messages[0].extrait!.length).toBeLessThanOrEqual(WORKSPACE_LIMITS.snippetChars);
  });

  it("l'ALERTE de manipulation traverse jusqu'à l'écran", () => {
    // Un message qui tente de donner des ordres à Adam doit se voir, pas se taire.
    const b = composeWorkspace("gmail_search", raw)!.blocks[0];
    if (b.kind !== "mail") throw new Error("bloc inattendu");
    expect(b.messages[0].alerte).toEqual(["consigne intégrée au message"]);
  });

  it("« aucun message » ne compose pas de bloc vide", () => {
    expect(composeWorkspace("gmail_search", J({ resultat: "aucun message correspondant", precision: "…" }))).toBeNull();
  });
});

describe("l'agenda — un TABLEAU, pas un objet enveloppe", () => {
  it("compose les rendez-vous", () => {
    const c = composeWorkspace("read_calendar", J([
      { titre: "Comité produit", jour: "2026-08-27", heure: "09:30", lieu: "Alger", organisateur: "Amine", invites: ["Khaled (accepté)"], visio: "https://meet.example/x" },
    ]));
    const b = c!.blocks[0];
    expect(b.kind).toBe("agenda");
    if (b.kind !== "agenda") return;
    expect(b.title).toBe("Prochain rendez-vous");
    expect(b.events[0].visio).toContain("https://");
  });

  it("un agenda vide ne compose rien", () => {
    expect(composeWorkspace("read_calendar", J([]))).toBeNull();
  });
});

describe("la file de décisions", () => {
  it("compose ce qui attend, avec son lien", () => {
    const c = composeWorkspace("list_pending_decisions", J({
      total: 3,
      elements: [
        { titre: "Congé — Khaled", statut: "En attente", depuis: "2 jours", lien: "/validations/1" },
        { libelle: "Paiement imprimeur", etat: "À valider", date: "hier" },
      ],
    }));
    const b = c!.blocks[0];
    expect(b.kind).toBe("queue");
    if (b.kind !== "queue") return;
    expect(b.total).toBe(3);
    expect(b.items[0].href).toBe("/validations/1");
    // `libelle` et `etat` sont des synonymes acceptés : la forme varie selon la source.
    expect(b.items[1].titre).toBe("Paiement imprimeur");
    expect(b.items[1].statut).toBe("À valider");
  });
});

describe("la fiche canonique", () => {
  it("aplatit les champs scalaires et laisse le reste au texte", () => {
    const c = composeWorkspace("inspect_record", J({
      type: "Dossier réglementaire",
      nom: "Nintedanib 100 mg",
      statut: "En instruction",
      etapeCourante: 4,
      chargeDuDossier: "Raihana",
      dateDepot: "2026-02-11",
      numeroAMM: "AMM-2026-118",
      lien: "/regulatory/abc",
      // Ces deux-là ne doivent PAS devenir des champs : les afficher entiers ferait de la
      // fiche un vidage de base.
      historique: [{ date: "2026-02-11", etape: "Dépôt" }],
      produit: { id: "p1", nom: "Nintedanib" },
    }));
    const b = c!.blocks[0];
    expect(b.kind).toBe("record");
    if (b.kind !== "record") return;
    expect(b.title).toBe("Nintedanib 100 mg");
    expect(b.href).toBe("/regulatory/abc");
    const labels = b.fields.map((f) => f.label);
    expect(labels).toContain("Statut");
    // Capitale FRANÇAISE (« Chargé du dossier », pas « Chargé Du Dossier ») ET accent rendu.
    expect(labels).toContain("Chargé du dossier");
    // Les clés JSON n'ont pas d'accent ; l'écran du PDG, si.
    expect(labels).toContain("Étape courante");
    expect(labels).toContain("Date de dépôt");
    // …et un sigle reste un sigle, même quand le mot d'avant est corrigé.
    expect(labels).toContain("Numéro AMM");
    expect(labels).not.toContain("Historique");
    expect(labels).not.toContain("Produit");
  });

  it("une fiche trop maigre ne mérite pas un bloc", () => {
    expect(composeWorkspace("inspect_record", J({ nom: "X" }))).toBeNull();
  });
});

describe("LA RÈGLE DE SÛRETÉ — l'inconnu ne s'affiche pas", () => {
  it("un outil hors de la table ne compose RIEN, même avec du JSON parfait", () => {
    // C'est exactement le cas de la fuite : `search_everything` rendait 27 résultats bruts,
    // dont six lignes de salaire, en réponse à « Bonsoir, ça va ? ».
    const resultats = J({
      total: 27,
      resultats: [
        { type: "paie", personne: "Amine Djouamai", brut: 480000, net: 361200 },
        { type: "dossier", nom: "Raltegravir" },
      ],
    });
    expect(composeWorkspace("search_everything", resultats)).toBeNull();
  });

  it("un texte libre ne compose rien", () => {
    expect(composeWorkspace("directory_list", "Rien n'attend votre décision pour l'instant.")).toBeNull();
  });

  it("un JSON TRONQUÉ ne compose rien — on ne devine pas ce qui manque", () => {
    expect(composeWorkspace("directory_list", '{"total":120,"salaries":[{"nom":"Salar')).toBeNull();
  });

  it("un JSON valide mais de forme étrangère ne compose rien", () => {
    expect(composeWorkspace("directory_list", J({ autreChose: [1, 2, 3] }))).toBeNull();
    expect(composeWorkspace("gmail_search", J({ messages: "pas un tableau" }))).toBeNull();
  });

  it("des éléments sans nom sont écartés — une ligne vide n'apprend rien", () => {
    expect(composeWorkspace("directory_lookup", J({ personnes: [{ poste: "Inconnu" }] }))).toBeNull();
  });

  it("la table de correspondance est FERMÉE et connue", () => {
    // CE QUI RESTE DEHORS EST LE POINT. `read_payroll` et `employee_360` rendent des lignes
    // parfaitement tabulables — et c'est précisément pour cela qu'elles n'y sont pas : un
    // affichage capable de tout montrer finit par tout montrer, y compris six salaires en
    // réponse à « Bonsoir, ça va ? ». La recherche fédérée est exclue pour l'autre raison :
    // ses résultats sont hétérogènes, et un tableau de choses différentes ment sur leur nature.
    for (const t of ["search_everything", "read_payroll", "employee_360", "gdrive_search"]) {
      expect(COMPOSABLE_TOOLS).not.toContain(t);
    }
    expect([...COMPOSABLE_TOOLS].sort()).toEqual([
      "directory_list", "directory_lookup", "gmail_search",
      "inspect_record", "list_pending_decisions", "read_budget", "read_calendar",
      "read_hr_overview", "regulatory_portfolio", "regulatory_workload", "search_courriers",
    ]);
  });
});

describe("le tableau générique — un outil, pas un comportement par défaut", () => {
  it("il n'est JAMAIS appliqué automatiquement par `composeWorkspace`", () => {
    // Il existe pour être appelé explicitement. S'il s'appliquait tout seul, la règle de
    // sûreté ci-dessus n'existerait plus.
    expect(composeWorkspace("un_outil_quelconque", J([{ a: 1, b: 2 }, { a: 3, b: 4 }]))).toBeNull();
  });

  it("appelé explicitement, il ne garde que les colonnes PARTAGÉES", () => {
    const b = tableFromRows("Test", [
      { nom: "A", montant: 10, exotique: "x" },
      { nom: "B", montant: 20 },
      { nom: "C", montant: 30 },
    ]);
    expect(b?.kind).toBe("table");
    if (b?.kind !== "table") return;
    expect(b.columns.map((c) => c.key)).toEqual(["nom", "montant"]);
    // Une colonne entièrement numérique s'aligne à droite.
    expect(b.columns.find((c) => c.key === "montant")?.numeric).toBe(true);
    expect(b.columns.find((c) => c.key === "nom")?.numeric).toBe(false);
  });

  it("une seule ligne ne fait pas un tableau", () => {
    expect(tableFromRows("Test", [{ a: 1 }])).toBeNull();
  });

  it("les clés de plomberie ne deviennent pas des colonnes", () => {
    const b = tableFromRows("Test", [
      { id: "ck1", lien: "/courriers", reference: "C-1", objet: "Devis" },
      { id: "ck2", lien: "/courriers", reference: "C-2", objet: "Facture" },
    ]);
    expect(b?.kind).toBe("table");
    if (b?.kind !== "table") return;
    expect(b.columns.map((c) => c.key)).toEqual(["reference", "objet"]);
  });
});

/**
 * « DANS UN TABLEAU » — la demande que le produit refusait.
 *
 *   PDG   — Montre moi les dossiers les plus avancées de regulatory
 *   PDG   — Dans un tableau
 *   Adam  — Je ne peux pas afficher de tableaux Markdown ici.
 *
 * Puis, sur un export :
 *
 *   PDG   — Montre le moi ici
 *   Adam  — Je ne peux pas afficher un fichier Excel.
 *
 * Les deux refus étaient faux. Ce qui manquait n'était pas le renderer — il existait — mais le
 * CHEMIN entre une lecture canonique qui rend des lignes et le bloc qui sait les dessiner.
 */
describe("les lectures qui rendent des lignes composent un tableau", () => {
  it("les courriers — un tableau nu (la dernière question du transcript)", () => {
    const c = composeWorkspace("search_courriers", J([
      { id: "a", reference: "C-2026-018", objet: "Dépôt ANPP", sens: "Départ", parti: "2026-08-24", lien: "/courriers" },
      { id: "b", reference: "C-2026-019", objet: "Accusé PCH", sens: "Arrivée", parti: null, lien: "/courriers" },
    ]));
    expect(c?.blocks[0].kind).toBe("table");
    const b = c?.blocks[0];
    if (b?.kind !== "table") return;
    expect(b.rows).toHaveLength(2);
    expect(b.columns.map((x) => x.key)).not.toContain("id");
  });

  it("les dossiers Regulatory — les lignes sont sous leur clé", () => {
    const c = composeWorkspace("regulatory_portfolio", J({
      partenaire: { demande: "SD", resolu: "S.D. Pharmaceuticals" },
      total: 2,
      dossiers: [
        { reference: "R-001", produit: "Raltegravir", statut: "En instruction", etape: "Recevabilité" },
        { reference: "R-002", produit: "Nintedanib", statut: "Déposé", etape: "Dépôt" },
      ],
    }));
    const b = c?.blocks[0];
    expect(b?.kind).toBe("table");
    if (b?.kind !== "table") return;
    expect(b.title).toBe("Dossiers Regulatory");
    expect(b.rows[0].cells.produit).toBe("Raltegravir");
  });

  it("l'effectif par entité — la ventilation s'AFFICHE, elle ne se raconte pas", () => {
    const c = composeWorkspace("read_hr_overview", J({
      perimetre: "TOUTE LA PLATEFORME — 2 entités confondues (Adventum, Pharmagène)",
      effectifActif: 18,
      parEntite: [
        { entite: "Adventum", effectifActif: 11, effectifTotal: 12 },
        { entite: "Pharmagène", effectifActif: 7, effectifTotal: 7 },
      ],
    }));
    const b = c?.blocks[0];
    expect(b?.kind).toBe("table");
    if (b?.kind !== "table") return;
    expect(b.rows.map((r) => r.cells.entite)).toEqual(["Adventum", "Pharmagène"]);
  });

  it("une lecture autorisée mais SANS lignes exploitables ne compose rien", () => {
    // La réponse reste du texte : mieux vaut pas de tableau qu'un tableau d'une ligne.
    expect(composeWorkspace("regulatory_portfolio", J({ total: 1, dossiers: [{ reference: "R-001" }] }))).toBeNull();
    expect(composeWorkspace("search_courriers", J([]))).toBeNull();
  });

  it("les lectures les plus sensibles restent HORS de la table, même en forme de lignes", () => {
    // `read_payroll` rend des lignes parfaitement tabulables. Elle n'est pas autorisée, donc
    // elle ne compose rien — c'est la règle qui a fermé l'incident des six salaires.
    expect(composeWorkspace("read_payroll", J([
      { salarie: "A", net: 120000 }, { salarie: "B", net: 98000 },
    ]))).toBeNull();
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * `_blocs` — CE QU'UNE LECTURE DÉCLARE ELLE-MÊME MONTRER.
 *
 * Ce qui suit vérifie la seule chose qui compte : la déclaration est REVALIDÉE. Un outil peut
 * dire ce qu'il veut, ce fichier ne rend que ce qu'il a relu champ par champ. Sans cela,
 * `_blocs` serait la porte dérobée que tout le reste du module s'emploie à fermer.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
describe("les jauges — « il reste combien ? » répondu par une longueur", () => {
  it("un bloc de progression déclaré arrive à l'écran", () => {
    const c = composeWorkspace("read_budget", J({
      restantDzd: 340_000,
      _blocs: [{
        kind: "progress", title: "Consommation des enveloppes",
        gauges: [
          { label: "Ad & Pro", valeur: 2_660_000, total: 3_000_000, unite: "DZD", detail: "reste 340 000 DZD", ton: "attention" },
          { label: "Formation", valeur: 120_000, total: 900_000, unite: "DZD" },
        ],
      }],
    }));
    const b = c?.blocks[0];
    expect(b?.kind).toBe("progress");
    if (b?.kind !== "progress") return;
    expect(b.gauges).toHaveLength(2);
    expect(b.gauges[0].ton).toBe("attention");
    expect(b.gauges[1].ton).toBeUndefined(); // non déclaré : l'écran déduira du seuil
  });

  it("une jauge sans valeur chiffrée est écartée — une barre sans nombre ne dit rien", () => {
    expect(composeWorkspace("read_budget", J({
      _blocs: [{ kind: "progress", title: "T", gauges: [{ label: "Sans valeur" }] }],
    }))).toBeNull();
  });

  it("un ton inventé est ignoré, pas propagé", () => {
    const c = composeWorkspace("read_budget", J({
      _blocs: [{ kind: "progress", title: "T", gauges: [{ label: "A", valeur: 10, total: 20, ton: "arc-en-ciel" }] }],
    }));
    const b = c?.blocks[0];
    if (b?.kind !== "progress") throw new Error("bloc attendu");
    expect(b.gauges[0].ton).toBeUndefined();
  });
});

describe("les documents montrés sur place", () => {
  const doc = (over: Record<string, unknown> = {}) => J({
    affiche: "Contrat Kwality.pdf",
    _blocs: [{
      kind: "document", title: "Document",
      docs: [{ nom: "Contrat Kwality.pdf", href: "/api/drive/ck1/raw", type: "pdf", taille: "1,2 Mo", ...over }],
    }],
  });

  it("un PDF interne s'affiche", () => {
    const c = composeWorkspace("show_document", doc());
    const b = c?.blocks[0];
    expect(b?.kind).toBe("document");
    if (b?.kind !== "document") return;
    expect(b.docs[0].type).toBe("pdf");
    expect(b.docs[0].href).toBe("/api/drive/ck1/raw");
  });

  it("UNE URL EXTERNE NE S'OUVRE PAS — jamais un site tiers dans un cadre sous la réponse", () => {
    for (const href of ["https://exemple.test/x.pdf", "//exemple.test/x.pdf", "javascript:alert(1)"]) {
      expect(composeWorkspace("show_document", doc({ href })), href).toBeNull();
    }
  });

  it("un type inconnu retombe sur « autre » — on ne prétend pas savoir l'afficher", () => {
    const c = composeWorkspace("show_document", doc({ type: "hologramme" }));
    const b = c?.blocks[0];
    if (b?.kind !== "document") throw new Error("bloc attendu");
    expect(b.docs[0].type).toBe("autre");
  });

  it("une feuille arrive DÉJÀ LUE — c'est ce qui permet de relire un export avant de l'envoyer", () => {
    const c = composeWorkspace("show_document", J({
      _blocs: [{
        kind: "document", title: "Aperçu du fichier",
        docs: [{
          nom: "Export Regulatory.xlsx", href: "/api/drive/ck9/raw", type: "feuille",
          feuille: {
            columns: [{ key: "c0", label: "Référence" }, { key: "c1", label: "Produit" }],
            rows: [{ c0: "REG-001", c1: "Raltegravir" }, { c0: "REG-002", c1: "Nintedanib" }],
            total: 69,
          },
        }],
      }],
    }));
    const b = c?.blocks[0];
    if (b?.kind !== "document") throw new Error("bloc attendu");
    expect(b.docs[0].feuille?.rows).toHaveLength(2);
    // Le total du FICHIER, pas celui de l'aperçu : « 69 lignes » se dit, on n'en montre que 2.
    expect(b.docs[0].feuille?.total).toBe(69);
  });

  it("une feuille sans colonnes n'est pas une feuille", () => {
    const c = composeWorkspace("show_document", doc({
      type: "feuille", feuille: { columns: [], rows: [{ a: "1" }], total: 1 },
    }));
    const b = c?.blocks[0];
    if (b?.kind !== "document") throw new Error("bloc attendu");
    expect(b.docs[0].feuille).toBeUndefined();
  });
});

describe("ce que `_blocs` NE permet PAS", () => {
  it("un type de bloc inconnu est écarté en silence", () => {
    expect(composeWorkspace("un_outil", J({ _blocs: [{ kind: "video", title: "T", src: "/x.mp4" }] }))).toBeNull();
  });

  it("un bloc sans titre est écarté", () => {
    expect(composeWorkspace("read_budget", J({
      _blocs: [{ kind: "progress", gauges: [{ label: "A", valeur: 1, total: 2 }] }],
    }))).toBeNull();
  });

  it("un `kind` que le validateur ne connaît pas est écarté — la liste est FERMÉE", () => {
    // La règle exacte : `readBlock` ne rend QUE les formes dont il sait vérifier chaque champ.
    // `queue`, `mail`, `agenda`, `directory` et `record` ont leur traducteur dédié et une
    // validation qui leur est propre ; les déclarer ici ouvrirait un chemin qui la contourne.
    for (const kind of ["queue", "mail", "agenda", "directory", "record", "video", "iframe"]) {
      expect(composeWorkspace("un_outil", J({
        _blocs: [{ kind, title: "T", items: [{ titre: "x" }], rows: [{ a: "1" }], people: [{ nom: "X" }] }],
      })), kind).toBeNull();
    }
  });

  it("`people` EST déclarable — et c'est une décision, pas un oubli", () => {
    // Les trois chiffres d'une fiche (dossiers portés, retards, part dans les délais) ne sont
    // PAS inférables d'un JSON de coordonnées : seul l'outil qui a lu le portefeuille les
    // connaît. La déclaration reste revalidée champ par champ par `readPerson`.
    const c = composeWorkspace("directory_lookup", J({
      _blocs: [{
        kind: "people", title: "Raihana",
        people: [{
          nom: "Raihana", poste: "Affaires réglementaires",
          statut: { label: "Active", ton: "succes" },
          metriques: [{ valeur: "12", label: "Dossiers assignés" }, { valeur: "3", label: "En retard", ton: "alerte" }],
          coordonnees: [{ canal: "e-mail", valeur: "r@adventum.dz" }],
        }],
        actions: [{ libelle: "Écrire", phrase: "Prépare un mail à Raihana" }],
      }],
    }));
    const b = c?.blocks[0];
    expect(b?.kind).toBe("people");
    if (b?.kind !== "people") return;
    expect(b.people[0].metriques).toHaveLength(2);
    expect(b.people[0].statut?.ton).toBe("succes");
    expect(b.actions).toHaveLength(1);
  });

  it("une personne sans nom n'est pas une personne", () => {
    expect(composeWorkspace("directory_lookup", J({
      _blocs: [{ kind: "people", title: "T", people: [{ poste: "Inconnu" }] }],
    }))).toBeNull();
  });

  it("`_blocs` absent : le comportement d'avant, à l'identique", () => {
    const c = composeWorkspace("directory_lookup", J({ personnes: [{ nom: "Raihana", coordonnees: [] }] }));
    expect(c?.blocks[0].kind).toBe("people");
  });
});

/**
 * « Ok affiche moi les validations a faire s'il y'en a, je les valide depuis ici. »
 * Demandé trois fois. La file ne rendait que des liens.
 */
describe("trancher depuis la conversation", () => {
  const queue = (actions: unknown) => J({
    total: 1,
    elements: [{ titre: "VAL-2026-014 — Facture imprimeur", statut: "À valider", lien: "/validations", actions }],
  });

  it("les gestes traversent jusqu'au bloc", () => {
    const c = composeWorkspace("list_pending_decisions", queue([
      { libelle: "Approuver", phrase: "Approuve la validation VAL-2026-014", ton: "primaire" },
      { libelle: "Refuser", phrase: "Refuse la validation VAL-2026-014", ton: "danger" },
    ]));
    const b = c?.blocks[0];
    if (b?.kind !== "queue") throw new Error("file attendue");
    expect(b.items[0].actions).toHaveLength(2);
    expect(b.items[0].actions?.[0].phrase).toContain("VAL-2026-014");
    // Le lien SURVIT : il mène à la demande complète avec ses pièces. Il n'est plus la seule issue.
    expect(b.items[0].href).toBe("/validations");
  });

  it("un geste sans phrase ne s'affiche pas — un bouton qui n'envoie rien trahit sa promesse", () => {
    const c = composeWorkspace("list_pending_decisions", queue([{ libelle: "Approuver" }]));
    const b = c?.blocks[0];
    if (b?.kind !== "queue") throw new Error("file attendue");
    expect(b.items[0].actions).toBeUndefined();
  });

  it("une ligne NON décidable n'a pas de bouton", () => {
    // L'étape séquentielle dont ce n'est pas encore le tour : l'exécution refuserait, et un
    // bouton qui refuse est pire que pas de bouton.
    const c = composeWorkspace("list_pending_decisions", queue(undefined));
    const b = c?.blocks[0];
    if (b?.kind !== "queue") throw new Error("file attendue");
    expect(b.items[0].actions).toBeUndefined();
  });

  it("au plus deux gestes par ligne — au-delà, la file devient un formulaire", () => {
    const c = composeWorkspace("list_pending_decisions", queue([
      { libelle: "A", phrase: "a" }, { libelle: "B", phrase: "b" },
      { libelle: "C", phrase: "c" }, { libelle: "D", phrase: "d" },
    ]));
    const b = c?.blocks[0];
    if (b?.kind !== "queue") throw new Error("file attendue");
    expect(b.items[0].actions).toHaveLength(2);
  });
});

describe("modifier un champ depuis la conversation", () => {
  const dossier = (field: Record<string, unknown>) => composeWorkspace("inspect_record", J({
    _blocs: [{
      kind: "dossier", title: "REG-2026-041",
      fields: [{ label: "Responsable", value: "Benkaci", ...field }],
    }],
  }));

  const champ = (c: ReturnType<typeof composeWorkspace>) => {
    const b = c?.blocks[0];
    if (b?.kind !== "dossier") throw new Error("dossier attendu");
    return b.fields[0];
  };

  it("un champ modifiable porte sa phrase, son type et ses options", () => {
    const f = champ(dossier({
      editable: {
        phrase: "Passe REG-2026-041 à l'étape « %s »",
        type: "choix",
        options: ["Dépôt", "Décision"],
      },
    }));
    expect(f.editable?.phrase).toBe("Passe REG-2026-041 à l'étape « %s »");
    expect(f.editable?.type).toBe("choix");
    expect(f.editable?.options).toEqual(["Dépôt", "Décision"]);
  });

  it("SANS `%s`, l'édition est REFUSÉE — le champ retombe en lecture seule", () => {
    // LA RÈGLE QUI COMPTE. Une phrase sans emplacement n'emporte pas la valeur saisie : le
    // bouton enverrait une phrase FIGÉE, donc modifierait autre chose que ce que la personne
    // vient de taper. Mieux vaut un champ non modifiable qu'un champ qui change autre chose.
    const f = champ(dossier({ editable: { phrase: "Réassigne le dossier", type: "texte" } }));
    expect(f.editable).toBeUndefined();
    expect(f.value).toBe("Benkaci");
  });

  it("un type d'édition inconnu est écarté — la liste est FERMÉE", () => {
    for (const type of ["fichier", "html", "script", ""]) {
      expect(champ(dossier({ editable: { phrase: "Change en %s", type } })).editable).toBeUndefined();
    }
  });

  it("une édition sans phrase, ou pas un objet, ne casse rien", () => {
    expect(champ(dossier({ editable: { type: "texte" } })).editable).toBeUndefined();
    expect(champ(dossier({ editable: "oui" })).editable).toBeUndefined();
    expect(champ(dossier({})).editable).toBeUndefined();
  });

  it("les options sont bornées et l'aide écourtée — une liste de mille choix n'est pas un choix", () => {
    const f = champ(dossier({
      editable: {
        phrase: "Change en %s", type: "choix",
        options: Array.from({ length: 60 }, (_, i) => `opt-${i}`),
        aide: "x".repeat(200),
      },
    }));
    expect(f.editable?.options?.length).toBeLessThanOrEqual(24);
    expect((f.editable?.aide ?? "").length).toBeLessThanOrEqual(60);
  });
});
