import type { PowerTool } from "@/platform/ia/outil";
import type { WorkspaceBlock } from "@/platform/ia/workspace/protocol";
import type { PropositionCarte } from "../operations";
import type { MemoireProposee } from "../../domaine/memoire-ui";
import { dedoublonner, lireObservations, texteDObservation, type Observation } from "../../domaine/observation/contrat";
import { lectureDeSortie, projeterCarte, projeterFichier } from "../../domaine/observation/projecteurs";
import type { GesteObserve } from "../../domaine/observation/controle-final";
import { observationActive } from "./interrupteurs";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE JOURNAL DU TOUR (lot I1, décision 0063 ; audit AU1 §3.1, §4.1) — UN objet au lieu des tableaux parallèles du tour
 * (cartes, sorties, mémoires, notes, visuels, analyses, sous-missions, pilotages échoués), alimenté à UN endroit :
 * l'ENVELOPPE des outils (`envelopper`).
 *
 * L'enveloppe recueille ce que chaque geste a produit, sans changer la signature des outils :
 *   • une CARTE préparée (une proposition de plus) → son observation (`projeterCarte`, les mails tels qu'ils partiront) ;
 *     et la sortie rendue au modèle EST cette projection (étape 2) : il décrit ce qu'il voit, plus une consigne ;
 *   • des observations DÉCLARÉES par un producteur (`_observations` dans sa sortie JSON : missions, fichiers) → reprises,
 *     puis retirées de ce que lit le modèle (il lit la sortie, pas le contrat) ;
 *   • un fichier du Drive cité (`/api/drive/<id>/raw`) → son observation ;
 *   • une lecture tabulaire (un tableau d'objets) → combien de lignes, quelles colonnes, quels identifiants ;
 *   • un ÉCHEC (statut REFUS, AMBIGU, ECHEC, BLOQUE, INCOMPLET, RIEN) → l'outil n'est pas une preuve (garde de vérité).
 *
 * Un outil appelé DANS un autre (`envoyer_mail` → `envoyer_gmail`) n'est observé qu'une fois, au niveau le plus haut :
 * c'est là que la carte est complète (renommée « Envoyer par … », avertissements ajoutés).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const STATUTS_ECHEC = new Set(["REFUS", "AMBIGU", "ECHEC", "BLOQUE", "INCOMPLET", "RIEN"]);
const CLE_DECLAREES = "_observations";
const DRIVE = /\/api\/drive\/([A-Za-z0-9_-]{8,})\/raw/g;

function json(s: string): Record<string, unknown> | null {
  try {
    const o = JSON.parse(s) as unknown;
    return o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, unknown>) : null;
  } catch { return null; }
}

export class JournalDuTour {
  /** Les cartes préparées (une par tour : l'écran montre la première). */
  readonly propositions: PropositionCarte[] = [];
  /** Ce que les lectures ont rendu — la preuve des composants et des chiffres (R5, K1). */
  readonly sorties: string[] = [];
  readonly memoires: MemoireProposee[] = [];
  readonly notesProposees: string[] = [];
  /** K2 : les visuels générés ; K1 : les analyses calculées par le code (blocs posés sous la réponse). */
  readonly visuels: WorkspaceBlock[] = [];
  readonly blocsCalcules: WorkspaceBlock[] = [];
  /** K3 : les sous-missions lancées pendant le tour. */
  readonly travauxLances: string[] = [];
  /**
   * I5 (décision 0069) : CHAQUE geste du tour (outil, statut de sa sortie, échec) et TOUTES les sorties telles que le modèle
   * les a lues — le contrôle final y confronte le message (« je n'ai pas trouvé » alors qu'une lecture a été tentée, un
   * chiffre qu'aucune sortie ne rend). Lecture seule : rien ne change pour les autres lecteurs du journal.
   */
  readonly gestes: GesteObserve[] = [];
  readonly toutesLesSorties: string[] = [];
  private readonly echecs = new Set<string>();
  private readonly obs: Observation[] = [];
  private profondeur = 0;
  private readonly enveloppes = new WeakSet<PowerTool>();

  /**
   * `pourModele` : ce qui part au modèle passe par la même garde que toute sortie d'outil (repères du coffre, ou valeurs
   * en clair que la personne a le droit de voir) — une projection de carte peut porter une valeur substituée.
   */
  constructor(private readonly pourModele: (s: string) => Promise<string> | string = (s) => s) {}

  /** Les observations du tour, une par objet (la dernière l'emporte). */
  observations(): Observation[] { return dedoublonner(this.obs); }

  /** Noter une observation construite ailleurs (un tour joué hors outil, un banc). */
  noter(...o: Observation[]): void { this.obs.push(...o); }

  /** Les outils appelés qui PROUVENT : ceux dont la sortie n'a pas dit un échec. */
  reussis(appeles: readonly string[]): string[] { return appeles.filter((n) => !this.echecs.has(n)); }

  /** L'enveloppe : la même pour tous les outils du tour (`prouve` : la sortie compte parmi les preuves des composants). */
  envelopper(o: PowerTool, opts: { prouve?: boolean } = {}): PowerTool {
    if (this.enveloppes.has(o)) return o;
    const enveloppe: PowerTool = {
      ...o,
      run: async (entree, u) => {
        if (this.profondeur > 0) return o.run(entree, u);
        this.profondeur++;
        const avant = this.propositions.length;
        let sortie: string;
        try { sortie = await o.run(entree, u); } finally { this.profondeur--; }
        if (opts.prouve) this.sorties.push(sortie);
        const lue = json(sortie);
        const statut = typeof lue?.statut === "string" ? lue.statut.toUpperCase() : null;
        if (statut && STATUTS_ECHEC.has(statut)) this.echecs.add(o.def.name);
        this.gestes.push({ outil: o.def.name, libelle: o.label, statut, echec: !!statut && STATUTS_ECHEC.has(statut), lignes: typeof lue?.total === "number" ? lue.total : null, entree });
        this.toutesLesSorties.push(sortie);
        if (!observationActive()) return sortie;
        // 1. Les observations DÉCLARÉES par le producteur — reprises, puis retirées de ce que lit le modèle.
        if (lue && CLE_DECLAREES in lue) {
          this.obs.push(...lireObservations(lue[CLE_DECLAREES]));
          delete lue[CLE_DECLAREES];
          sortie = JSON.stringify(lue);
        }
        // 2. UNE CARTE préparée par ce geste : la sortie EST sa projection.
        if (this.propositions.length > avant) {
          const p = this.propositions[this.propositions.length - 1]!;
          const carte = projeterCarte({
            id: p.intentId, titre: p.proposition.title, statut: "PROPOSED", champs: p.proposition.fields, avertissements: p.proposition.warnings,
            aCompleter: !!(p.proposition.payload as { aCompleter?: unknown } | undefined)?.aCompleter, mails: p.proposition.mails,
            simulation: p.proposition.simulation?.resume ?? null, ressaisie: p.proposition.confirmText ?? null,
          });
          this.obs.push(carte);
          return this.pourModele(JSON.stringify({ statut: "EN_ATTENTE_DE_CONFIRMATION", observation: texteDObservation(carte) }));
        }
        // 3. Un fichier du Drive cité par la sortie.
        for (const m of sortie.matchAll(DRIVE)) {
          const nom = [lue?.nom, lue?.nomFichier, lue?.fichier, lue?.name].find((x): x is string => typeof x === "string") ?? "fichier";
          this.obs.push(projeterFichier({ id: m[1]!, nom, existe: true, source: o.label }));
        }
        // 4. Une lecture tabulaire.
        const lecture = statut && STATUTS_ECHEC.has(statut) ? null : lectureDeSortie(o.def.name, o.label, sortie);
        if (lecture) this.obs.push(lecture);
        return sortie;
      },
    };
    this.enveloppes.add(enveloppe);
    return enveloppe;
  }
}
