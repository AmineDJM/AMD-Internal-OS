/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES OUTILS DES FICHIERS (mandat 5 §41).
 *
 *   · `drive_inventaire` — recenser, chercher les doublons, les orphelins, les versions
 *     empilées ; PROPOSER un classement par le CONTENU. Rien n'est modifié.
 *   · `drive_lot`        — l'aperçu AVANT, l'exécution avec reprise et réessais, le rapport
 *     ARITHMÉTIQUE après, et le plan de retour de ce qui a réellement été fait.
 *   · `format_lire`      — lire un fichier tabulaire en DÉTECTANT tout (encodage, séparateur,
 *     en-tête, locale) et en disant ce qui n'a pas été compris.
 *   · `format_convertir` — ce qu'une conversion PERD, dit AVANT de la faire.
 *
 * Aucune SUPPRESSION nulle part : le pont la refuse, structurellement. Les gestes proposés sont
 * tous réversibles, et le plan de retour est produit en même temps que le plan d'aller.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import type { PowerTool } from "@/lib/assistant/power-tools";
import { blocTableau } from "@/lib/assistant/sandbox-tools";
import { declarerProvenance, faitCalcule } from "@/platform/in-process/fabric/provenance";
import {
  type Geste, type Proposition,
  apercuTexte, appliquerGeste, avertissementConversion, capacitesServeur, conversion, conversionsDepuis, dossierPour, ecrireCsv,
  executerLot, formatDe, gesteDejaFait, gestesDeClassement, lireJson, lireTableur, orphelins, preparerLot,
  etatsActuels, proposerClassement, recenser, trouverDoublons,
} from "@/platform/in-process/fichiers";
import { arrondi } from "@/platform/in-process/calcul";
import { sansBloquer } from "@/lib/journal";

type Acteur = Parameters<PowerTool["run"]>[1];

const str = (input: Record<string, unknown>, key: string): string => (typeof input[key] === "string" ? (input[key] as string).trim() : "");
const num = (input: Record<string, unknown>, key: string): number | undefined => {
  const v = input[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
};
const liste = (input: Record<string, unknown>, key: string): string[] =>
  Array.isArray(input[key]) ? (input[key] as unknown[]).filter((x): x is string => typeof x === "string") : [];

const mo = (octets: number): string => `${arrondi(octets / 1_048_576, 2)} Mo`;

const provenance = (user: Acteur, outil: string, libelle: string, valeur: number | string, entrees: readonly string[], transformation: string, formule: string) =>
  declarerProvenance([faitCalcule({ outil, acteur: user.id, libelle, valeur, entrees, transformation, formule: formule.slice(0, 300) })]);

export const FICHIERS_TOOLS: PowerTool[] = [
  {
    def: {
      name: "drive_inventaire",
      description:
        "RECENSER ET COMPRENDRE le Drive, sans rien modifier. "
        + "analyses : « recensement » (combien, où, quels formats, quelle place) · « doublons » (IDENTIQUES au contenu, VERSIONS empilées « v2 / FINAL / (1) », RESSEMBLANTS — trois natures qui n'appellent pas la même chose, et le code dit que supprimer un identique ne libère AUCUN octet puisque le stockage le partage déjà) · "
        + "« orphelins » (aucune référence dans l'ERP et longtemps sans modification — candidats à l'ARCHIVAGE, jamais à la suppression) · "
        + "« classement » (propose une destination par le CONTENU du fichier, pas par son nom : « Scan_20260115_003.pdf » devient une facture parce qu'il contient « FACTURE N° » et un montant TTC ; chaque proposition cite son indice, porte sa confiance et son emplacement d'ORIGINE). "
        + "Les droits sont vérifiés NŒUD PAR NŒUD, et les fichiers écartés faute de droit sont COMPTÉS : « rien trouvé » et « pas eu le droit de regarder » ne sont pas la même réponse.",
      input_schema: {
        type: "object",
        properties: {
          analyse: { type: "string", enum: ["recensement", "doublons", "orphelins", "classement"] },
          dossier: { type: "string", description: "L'identifiant d'un dossier du Drive ; tout le Drive visible par défaut." },
          extensions: { type: "array", items: { type: "string" }, description: "Ne garder que ces extensions (pdf, xlsx, docx…)." },
          jours: { type: "number", description: "orphelins : depuis combien de jours sans modification (365 par défaut)." },
          limite: { type: "number", description: "Nombre de fichiers examinés (3 000 par défaut, 12 000 au plus)." },
          titre: { type: "string" },
        },
        required: ["analyse"],
      },
    },
    // Aucun droit propre : le PONT vérifie `canViewDrive` nœud par nœud, comme l'écran.
    allowed: () => true,
    label: "Inventaire du Drive",
    run: async (input, user) => {
      const analyse = str(input, "analyse").toLowerCase() || "recensement";
      const titre = str(input, "titre") || "Drive";
      const r = await recenser(user, { dossier: str(input, "dossier") || null, limite: num(input, "limite"), extensions: liste(input, "extensions") });
      if ("erreur" in r) return JSON.stringify({ ok: false, erreur: r.erreur });
      const base = {
        titre, fichiers: r.fichiers.length, dossiers: r.dossiers, place: mo(r.octets),
        ...(r.horsPerimetre ? { horsPerimetre: `${r.horsPerimetre} fichier(s) écarté(s) : ils ne vous sont pas ouverts dans le Drive.` } : {}),
        ...(r.tronque ? { avertissement: "Recensement tronqué au plafond : l'analyse porte sur une partie du Drive." } : {}),
      };
      if (!r.fichiers.length) return JSON.stringify({ ok: true, ...base, note: r.horsPerimetre ? "Aucun fichier VISIBLE : ce n'est pas la même chose qu'aucun fichier." : "Aucun fichier." });

      if (analyse === "recensement") {
        const parFormat = new Map<string, { n: number; octets: number }>();
        for (const f of r.fichiers) {
          const fmt = formatDe(f.nom);
          const c = parFormat.get(fmt) ?? { n: 0, octets: 0 };
          c.n += 1; c.octets += f.taille;
          parFormat.set(fmt, c);
        }
        const tab = [...parFormat.entries()].sort((a, b) => b[1].octets - a[1].octets).map(([format, c]) => ({ format, fichiers: c.n, place: mo(c.octets) }));
        const parDossier = new Map<string, number>();
        for (const f of r.fichiers) parDossier.set(f.chemin ?? "?", (parDossier.get(f.chemin ?? "?") ?? 0) + 1);
        const gros = [...r.fichiers].sort((a, b) => b.taille - a.taille).slice(0, 10).map((f) => ({ fichier: f.nom, place: mo(f.taille), dossier: f.chemin ?? "" }));
        return JSON.stringify({
          ok: true, ...base,
          parFormat: tab,
          dossiersLesPlusRemplis: [...parDossier.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([dossier, n]) => ({ dossier, fichiers: n })),
          plusGrosFichiers: gros,
          _blocs: [blocTableau(`${titre} — par format`, tab)].filter(Boolean), _blocsDecoratifs: true,
          _provenance: provenance(user, "drive_inventaire", titre, `${r.fichiers.length} fichiers, ${mo(r.octets)}`, ["Drive"], "recensement sous les droits, nœud par nœud", "canViewDrive"),
        });
      }

      if (analyse === "doublons") {
        const d = trouverDoublons(r.fichiers);
        if ("erreur" in d) return JSON.stringify({ ok: false, ...base, erreur: d.erreur });
        const tab = d.groupes.slice(0, 40).map((g) => ({
          nature: g.nature, "à garder": g.garder.nom, autres: g.autres.length,
          "libérable": mo(g.octetsLiberables), confiance: g.confiance,
          exemples: g.autres.slice(0, 3).map((f) => f.nom).join(", "),
        }));
        return JSON.stringify({
          ok: true, ...base,
          identiques: d.identiques, versions: d.versions, ressemblants: d.ressemblants,
          placeLiberable: mo(d.octetsLiberables),
          placeDejaPartagee: mo(d.octetsDejaPartages),
          groupes: d.groupes.slice(0, 25).map((g) => ({
            nature: g.nature, raison: g.raison,
            garder: { nom: g.garder.nom, dossier: g.garder.chemin, references: g.garder.references ?? 0 },
            autres: g.autres.map((f) => ({ nom: f.nom, dossier: f.chemin, references: f.references ?? 0, place: mo(f.taille) })),
            precautions: g.precautions, confiance: g.confiance,
          })),
          limites: d.limites,
          consigne: "Ne PROPOSER aucune suppression : dire ce qui est identique, ce qui est une version et ce qui n'est qu'un soupçon, et laisser la personne trancher.",
          _blocs: [blocTableau(`${titre} — doublons`, tab)].filter(Boolean), _blocsDecoratifs: true,
          _provenance: provenance(user, "drive_inventaire", titre, `${d.groupes.length} groupe(s) de doublons`, ["Drive"], "empreintes de contenu, radicaux de nom, distances", `${r.fichiers.length} fichiers examinés`),
        });
      }

      if (analyse === "orphelins") {
        const o = orphelins(r.fichiers, num(input, "jours") ?? 365);
        const tab = o.slice(0, 50).map((x) => ({ fichier: x.fichier.nom, dossier: x.fichier.chemin, "jours sans modification": x.joursSansModification, place: mo(x.fichier.taille) }));
        return JSON.stringify({
          ok: true, ...base, orphelins: o.length,
          placeConcernee: mo(o.reduce((s, x) => s + x.fichier.taille, 0)),
          liste: tab,
          consigne: "Ce sont des candidats à l'ARCHIVAGE. Aucun n'est proposé à la suppression : un fichier sans référence dans l'ERP peut avoir toute sa valeur ailleurs.",
          _blocs: [blocTableau(`${titre} — orphelins`, tab)].filter(Boolean), _blocsDecoratifs: true,
          _provenance: provenance(user, "drive_inventaire", titre, `${o.length} orphelin(s)`, ["Drive"], "aucune référence ERP et ancienneté", `seuil ${num(input, "jours") ?? 365} jours`),
        });
      }

      if (analyse === "classement") {
        const propositions: Proposition[] = [];
        // Le CONTENU est lu pour les fichiers texte : c'est lui qui fait la différence entre
        // « classé par ce que le fichier dit » et « classé par ce que son nom laisse croire ».
        for (const f of r.fichiers.slice(0, 300)) {
          const contenu = await apercuTexte(user, f.id).catch(sansBloquer("fichiers-tools.run.apercuTexte", ""));
          propositions.push(proposerClassement(f, contenu));
        }
        const classables = propositions.filter((p) => p.categorie !== "INCONNU");
        const gestes = gestesDeClassement(classables);
        const apercu = preparerLot(gestes);
        const tab = classables.slice(0, 50).map((p) => ({
          fichier: p.fichier.nom, categorie: p.categorie, destination: p.destination,
          origine: p.origine, confiance: p.confiance, raison: p.raison.slice(0, 90),
        }));
        return JSON.stringify({
          ok: true, ...base,
          examines: propositions.length, classables: classables.length,
          inconnus: propositions.length - classables.length,
          propositions: classables.slice(0, 40).map((p) => ({
            fichier: p.fichier.nom, origine: p.origine, destination: p.destination, categorie: p.categorie,
            confiance: p.confiance, raison: p.raison, indices: p.indices.map((i) => `${i.ou} : « ${i.extrait} »`),
            entites: p.entites, autresPossibles: p.concurrentes,
          })),
          apercuLot: "erreur" in apercu ? null : { prets: apercu.gestes.length, aConfirmer: apercu.aConfirmer.length, refuses: apercu.refuses.length, resume: apercu.resume },
          consigne: "Rien n'est déplacé. Pour appliquer, passer ces gestes à drive_lot — qui rendra l'aperçu, puis exécutera, puis dira le compte exact et gardera le plan de retour.",
          _blocs: [blocTableau(`${titre} — classement proposé`, tab)].filter(Boolean), _blocsDecoratifs: true,
          _provenance: provenance(user, "drive_inventaire", titre, `${classables.length} classement(s) proposé(s)`, ["Drive", "contenu des fichiers texte"], "indices pesés dans le nom et le contenu", "classement sémantique"),
        });
      }

      return JSON.stringify({ ok: false, erreur: `Analyse « ${analyse} » inconnue : recensement, doublons, orphelins, classement.` });
    },
  },

  {
    def: {
      name: "drive_lot",
      description:
        "APPLIQUER UN LOT de gestes sur des fichiers (déplacer, renommer, classer, archiver) — jamais supprimer, le pont le refuse. "
        + "Deux temps : « apercu » rend EXACTEMENT ce qui serait fait, sur quels fichiers, d'où vers où, avec le plan de RETOUR — et rien n'est modifié ; "
        + "« executer » applique, réessaie les échecs PASSAGERS (fichier verrouillé, délai) sans réessayer les refus de droit, CONTINUE après un échec, "
        + "reprend sans refaire ce qui porte déjà son reçu, et rend un compte ARITHMÉTIQUE (demandés = faits + déjà faits + échoués). "
        + "Un geste dont l'état d'origine n'est pas connu est REFUSÉ : il ne pourrait pas être annulé.",
      input_schema: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["apercu", "executer"], description: "apercu (défaut, ne modifie rien) ou executer." },
          gestes: { type: "array", items: { type: "object" }, description: "[{cible: identifiant du fichier, type: 'deplacer'|'renommer'|'classer'|'archiver', avant: {…}, apres: {nom?|parentId?|categorie?}, raison, confiance, libelle}]." },
          destination: { type: "string", description: "Un chemin de dossier (« Finances / Factures / 2026 ») créé s'il n'existe pas ; son identifiant remplace alors `apres.parentId` des gestes qui n'en ont pas." },
          seuilConfiance: { type: "number", description: "En dessous, le geste va « à confirmer » plutôt qu'à l'exécution (0,85 par défaut)." },
          titre: { type: "string" },
        },
        required: ["gestes"],
      },
    },
    // Aucun droit propre : chaque geste revérifie `canEditDrive` sur le fichier ET sur le dossier
    // d'arrivée, et l'audit porte le nom de la personne.
    allowed: () => true,
    label: "Lot de fichiers",
    run: async (input, user) => {
      const titre = str(input, "titre") || "Lot de fichiers";
      const mode = str(input, "mode").toLowerCase() === "executer" ? "executer" : "apercu";
      const bruts = Array.isArray(input.gestes) ? (input.gestes as Record<string, unknown>[]) : [];
      if (!bruts.length) return JSON.stringify({ ok: false, erreur: "Aucun geste fourni." });

      // La destination en clair devient un dossier réel — créé si besoin, sous le droit d'écriture.
      let parentId: string | null = null;
      const chemin = str(input, "destination");
      if (chemin) {
        const d = await dossierPour(user, chemin);
        if ("erreur" in d) return JSON.stringify({ ok: false, erreur: `Destination « ${chemin} » : ${d.erreur}` });
        parentId = d.id;
      }
      // L'ÉTAT D'AVANT EST LU AU SERVEUR, jamais pris du modèle : c'est lui qui rend le plan de
      // retour fiable. Un modèle qui oublie un champ produirait un « annuler » qui n'annule rien.
      const cibles = bruts.map((g) => String(g.cible ?? "")).filter(Boolean);
      const etats = new Map<string, { nom: string; parentId: string | null; categorie: string | null }>();
      for (const etat of await etatsActuels(cibles)) etats.set(etat.id, { nom: etat.name, parentId: etat.parentId, categorie: etat.category });

      const gestes: Geste[] = bruts.map((g, i) => {
        const apres = (typeof g.apres === "object" && g.apres !== null ? g.apres : {}) as Record<string, string | number | null>;
        if (parentId && apres.parentId === undefined) apres.parentId = parentId;
        const cible = String(g.cible ?? "");
        const reel = etats.get(cible);
        const avant = { ...((typeof g.avant === "object" && g.avant !== null ? g.avant : {}) as Record<string, string | number | null>) };
        // Chaque champ que le geste change doit avoir son état d'origine — lu en base.
        if (reel) {
          if (apres.nom !== undefined && avant.nom === undefined) avant.nom = reel.nom;
          if (apres.parentId !== undefined && avant.parentId === undefined) avant.parentId = reel.parentId;
          if (apres.categorie !== undefined && avant.categorie === undefined) avant.categorie = reel.categorie;
        }
        return {
          cible,
          type: (String(g.type ?? "deplacer") as Geste["type"]),
          avant,
          apres,
          raison: String(g.raison ?? "demandé"),
          confiance: typeof g.confiance === "number" ? g.confiance : 1,
          libelle: String(g.libelle ?? `${g.type ?? "geste"} ${i + 1}`),
        };
      }).filter((g) => g.cible);

      const apercu = preparerLot(gestes, { seuilConfiance: num(input, "seuilConfiance") });
      if ("erreur" in apercu) return JSON.stringify({ ok: false, erreur: apercu.erreur });
      const tableApercu = apercu.gestes.slice(0, 50).map((g) => ({ geste: g.type, fichier: g.cible, "de": String(g.avant.chemin ?? g.avant.parentId ?? "—"), "vers": String(g.apres.chemin ?? g.apres.parentId ?? g.apres.nom ?? "—"), confiance: g.confiance }));

      if (mode === "apercu") {
        return JSON.stringify({
          ok: true, titre, mode: "apercu", modifie: false,
          resume: apercu.resume,
          prets: apercu.gestes.length, aConfirmer: apercu.aConfirmer.map((g) => ({ fichier: g.cible, geste: g.type, confiance: g.confiance, raison: g.raison })),
          refuses: apercu.refuses,
          reversible: apercu.reversible,
          planDeRetour: apercu.planDeRetour.length,
          apercu: tableApercu,
          consigne: "RIEN n'a été modifié. Montrer cet aperçu, obtenir l'accord, puis rappeler avec mode « executer ».",
          _blocs: [blocTableau(`${titre} — aperçu`, tableApercu)].filter(Boolean), _blocsDecoratifs: true,
        });
      }

      const rapport = await executerLot(apercu.gestes, (g) => appliquerGeste(user, g), {
        dejaFait: gesteDejaFait,
        tentatives: 3,
        msMax: 120_000,
      });
      const tableRecus = rapport.recus.filter((x) => x.issue !== "FAIT").slice(0, 40).map((x) => ({ fichier: x.cible, geste: x.type, issue: x.issue, detail: x.detail.slice(0, 80), tentatives: x.tentatives }));
      return JSON.stringify({
        ok: rapport.echecs === 0,
        titre, mode: "executer", modifie: rapport.faits > 0,
        demandes: rapport.demandes, faits: rapport.faits, dejaFaits: rapport.ignores, echecs: rapport.echecs,
        compteJuste: rapport.compteJuste,
        interrompu: rapport.interrompu,
        ms: rapport.msTotal,
        resume: rapport.resume,
        causesDEchec: rapport.parEchec,
        ...(tableRecus.length ? { detail: tableRecus } : {}),
        planDeRetour: rapport.planDeRetour.length ? { gestes: rapport.planDeRetour.length, note: "Ces gestes ramènent chaque fichier réellement déplacé à son emplacement d'origine. Les repasser à drive_lot annule le lot." } : null,
        aConfirmer: apercu.aConfirmer.length,
        refuses: apercu.refuses,
        ...(tableRecus.length ? { _blocs: [blocTableau(`${titre} — ce qui n'est pas passé`, tableRecus)], _blocsDecoratifs: true } : {}),
        _provenance: provenance(user, "drive_lot", titre, rapport.resume, ["Drive"], "lot avec reprise, réessais et compte arithmétique", `${rapport.demandes} geste(s)`),
      });
    },
  },

  {
    def: {
      name: "format_lire",
      description:
        "LIRE UN FICHIER TABULAIRE en DÉTECTANT tout ce qu'un import rate d'habitude : l'encodage (un export de tableur français est en latin-1, pas en UTF-8), "
        + "le séparateur (par la RÉGULARITÉ des colonnes, pas par la fréquence — un texte plein de virgules n'est pas un CSV à virgules), la présence d'un en-tête, "
        + "et la LOCALE (« 1 234,56 » est français, « 1,234.56 » est anglais, « 1,234 » est AMBIGU et le code le dit plutôt que de convertir au hasard ; « 03/04/2026 » n'est pas une date décidable). "
        + "Rend les lignes typées, les colonnes avec leur type (une colonne MÊLÉE est signalée et reste en texte — un calcul dessus serait faux), et le RAPPORT : décisions prises, lignes mal formées, ce qui n'a pas été compris. "
        + "Source : « drive » (identifiant ou nom d'un fichier du Drive) ou « contenu » (texte fourni).",
      input_schema: {
        type: "object",
        properties: {
          drive: { type: "string", description: "Identifiant du fichier du Drive à lire." },
          contenu: { type: "string", description: "Le texte à lire directement." },
          separateur: { type: "string", description: "Imposer le séparateur (sinon détecté)." },
          entete: { type: "boolean", description: "Imposer la présence d'un en-tête (sinon détectée)." },
          max: { type: "number", description: "Nombre de lignes lues." },
          titre: { type: "string" },
        },
      },
    },
    allowed: () => true,
    label: "Lecture d'un tableau",
    run: async (input, user) => {
      const titre = str(input, "titre") || "Lecture";
      const contenu = str(input, "contenu");
      const drive = str(input, "drive");
      let source = "texte fourni dans la conversation";
      let brut: string = contenu;
      if (!contenu && drive) {
        const texte = await apercuTexte(user, drive).catch(sansBloquer("fichiers-tools.run.apercuTexte", ""));
        if (!texte) return JSON.stringify({ ok: false, erreur: "Fichier du Drive illisible en texte : soit il ne vous est pas ouvert, soit ce n'est pas un format tabulaire texte (CSV, TSV, TXT, JSON). Pour un classeur XLSX, passer par run_analysis avec « drive »." });
        brut = texte; source = `fichier ${drive} du Drive (début du contenu)`;
      }
      if (!brut) return JSON.stringify({ ok: false, erreur: "Donner « contenu » (le texte) ou « drive » (un fichier)." });

      // Du JSON reste du JSON : le lire comme un CSV donnerait une seule colonne.
      const texteBrut = brut;
      if (/^\s*[[{]/.test(texteBrut)) {
        const j = lireJson(texteBrut);
        if (j.ok) {
          const colonnes = [...new Set(j.lignes.flatMap((l) => Object.keys(l)))];
          return JSON.stringify({
            ok: true, titre, source, forme: j.forme, lignes: j.lignes.length, colonnes,
            apercu: j.lignes.slice(0, 30),
            note: `Contenu lu comme du ${j.forme.toUpperCase()}, pas comme un CSV.`,
            _blocs: [blocTableau(titre, j.lignes.slice(0, 50) as Record<string, unknown>[])].filter(Boolean), _blocsDecoratifs: true,
            _provenance: provenance(user, "format_lire", titre, `${j.lignes.length} ligne(s) ${j.forme}`, [source], "lecture JSON", j.forme),
          });
        }
      }

      const sepBrut = str(input, "separateur");
      const r = lireTableur(brut, {
        ...(sepBrut ? { separateur: (sepBrut === "\\t" ? "\t" : sepBrut) as "," | ";" | "\t" | "|" } : {}),
        ...(typeof input.entete === "boolean" ? { entete: input.entete } : {}),
        max: num(input, "max"),
      });
      if (!r.ok) return JSON.stringify({ ok: false, titre, source, erreur: r.erreur });
      const tabColonnes = r.colonnes.map((c) => ({ colonne: c.nom, type: c.type, remplies: c.remplies, vides: c.vides, distinctes: c.distinctes, "exemple": String(c.exemples[0] ?? ""), ...(c.detail ? { detail: c.detail } : {}) }));
      return JSON.stringify({
        ok: true, titre, source,
        lignes: r.rapport.lignesLues, colonnes: tabColonnes,
        detection: {
          encodage: r.rapport.encodage, separateur: r.rapport.separateur === "\t" ? "tabulation" : r.rapport.separateur,
          entete: r.rapport.entete, nombres: r.rapport.locale.nombres, dates: r.rapport.locale.dates,
          confiance: arrondi(r.rapport.confiance, 2),
        },
        decisions: r.rapport.decisions,
        ...(r.rapport.avertissements.length ? { avertissements: r.rapport.avertissements } : {}),
        ...(r.rapport.lignesMalFormees.length ? { lignesMalFormees: r.rapport.lignesMalFormees } : {}),
        ...(r.rapport.tronque ? { tronque: true } : {}),
        apercu: r.lignes.slice(0, 30),
        consigne: "Reprendre les avertissements : une colonne mêlée ou une locale indéterminée changent le sens des chiffres.",
        _blocs: [blocTableau(titre, r.lignes.slice(0, 50)), blocTableau(`${titre} — colonnes`, tabColonnes)].filter((b): b is Record<string, unknown> => Boolean(b)),
        _blocsDecoratifs: true,
        _provenance: provenance(user, "format_lire", titre, `${r.rapport.lignesLues} ligne(s), ${r.colonnes.length} colonne(s)`, [source], `lecture ${r.rapport.encodage}, séparateur détecté, locale ${r.rapport.locale.nombres}`, r.rapport.decisions.join(" ")),
      });
    },
  },

  {
    def: {
      name: "format_convertir",
      description:
        "CE QU'UNE CONVERSION PERD — dit AVANT de la faire. Donner « de » et « vers » (ou un nom de fichier), et l'outil rend : SANS PERTE, DESTRUCTIF (avec la liste exacte de ce qui meurt : "
        + "les autres feuilles, les formules, les macros, la mise en forme) ou INDISPONIBLE sur ce serveur (avec la ressource qui manque et l'alternative). "
        + "Sans « vers », rend toutes les conversions possibles depuis ce format, les sans-perte d'abord. "
        + "Peut aussi PRODUIRE un CSV à partir de lignes : la locale française impose alors le point-virgule, parce qu'une virgule décimale couperait les montants en deux.",
      input_schema: {
        type: "object",
        properties: {
          de: { type: "string", description: "Le format de départ, ou un nom de fichier." },
          vers: { type: "string", description: "Le format d'arrivée. Absent : toutes les possibilités." },
          lignes: { type: "array", items: { type: "object" }, description: "Des lignes à écrire en CSV." },
          locale: { type: "string", enum: ["fr", "en"], description: "La locale du fichier produit (fr par défaut)." },
          titre: { type: "string" },
        },
      },
    },
    allowed: () => true,
    label: "Conversion de format",
    run: async (input, user) => {
      const titre = str(input, "titre") || "Conversion";
      const lignes = Array.isArray(input.lignes) ? (input.lignes as Record<string, unknown>[]) : [];
      if (lignes.length) {
        const csv = ecrireCsv(lignes, { locale: str(input, "locale") === "en" ? "en" : "fr" });
        return JSON.stringify({
          ok: true, titre, produit: "csv",
          separateur: csv.separateur === "\t" ? "tabulation" : csv.separateur,
          note: csv.note,
          lignes: lignes.length,
          apercu: csv.texte.split("\r\n").slice(0, 8).join("\n"),
          contenu: csv.texte.length > 60_000 ? `${csv.texte.slice(0, 60_000)}… (tronqué : ${csv.texte.length} caractères)` : csv.texte,
          _provenance: provenance(user, "format_convertir", titre, `${lignes.length} ligne(s) en CSV`, ["lignes fournies"], "écriture CSV avec locale et séparateur cohérents", csv.note),
        });
      }
      const deBrut = str(input, "de");
      if (!deBrut) return JSON.stringify({ ok: false, erreur: "Donner « de » (un format ou un nom de fichier), ou « lignes » à écrire." });
      const de = deBrut.includes(".") ? formatDe(deBrut) : formatDe(`x.${deBrut}`);
      if (de === "inconnu") return JSON.stringify({ ok: false, erreur: `Format « ${deBrut} » non reconnu.` });
      const versBrut = str(input, "vers");
      if (!versBrut) {
        const toutes = conversionsDepuis(de, capacitesServeur());
        return JSON.stringify({
          ok: true, titre, de,
          possibles: toutes.map((c) => ({ vers: c.vers, nature: c.nature, perd: c.perd, conseil: avertissementConversion(c) })),
          note: "Les conversions SANS PERTE sont en tête. Une conversion destructive impose de garder l'original.",
          _provenance: provenance(user, "format_convertir", titre, `${toutes.length} conversion(s) possibles depuis ${de}`, [`format ${de}`], "table des pertes par format", "matrice de conversion"),
        });
      }
      const vers = versBrut.includes(".") ? formatDe(versBrut) : formatDe(`x.${versBrut}`);
      const c = conversion(de, vers, capacitesServeur());
      return JSON.stringify({
        ok: c.nature !== "IMPOSSIBLE",
        titre, de: c.de, vers: c.vers, nature: c.nature,
        conserve: c.conserve, perd: c.perd, reversible: c.reversible,
        ...(c.ressourceManquante ? { ressourceManquante: c.ressourceManquante } : {}),
        avertissement: avertissementConversion(c),
        consigne: c.nature === "DESTRUCTIF"
          ? "DIRE ce qui sera perdu AVANT de convertir, et garder l'original."
          : c.nature === "IMPOSSIBLE" ? "Nommer la ressource qui manque et proposer l'alternative — jamais « impossible » tout court." : undefined,
        _provenance: provenance(user, "format_convertir", titre, `${c.de} → ${c.vers} : ${c.nature}`, [`format ${c.de}`], "table des pertes par format", c.perd.join(", ") || "aucune perte"),
      });
    },
  },
];
