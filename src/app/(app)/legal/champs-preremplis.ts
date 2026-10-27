import type { FieldDef, MarqueDeChamp } from "@/components/shared/create-record-button";
import type { ChampPrerempli, PrerempliDocumentLegal } from "@/lib/pieces-lues/prerempli-document-legal";

/**
 * LES CHAMPS DE « NOUVEAU DOCUMENT », REMPLIS DEPUIS LA PIÈCE LUE — module PUR, sans import de valeur.
 *
 * La liste vient de `legalFields` (une seule définition, création et modification) ; ce module n'y ajoute rien
 * qu'elle ne sache déjà porter, il en pose les VALEURS :
 *
 *   • ce que la personne a déjà TOUCHÉ (`gardes`) l'emporte toujours — relire une autre pièce ne remplace que
 *     les champs qu'elle n'a pas touchés ;
 *   • la partie n'est retenue que CERTAINE ; sinon le sélecteur propose, sans choisir ;
 *   • une facture dont l'émetteur n'est pas prouvé n'a AUCUN sens par défaut (`sensExige`, revérifié au serveur) ;
 *   • le BC que la facture cite rejoint le menu « Fait suite à » s'il n'y était pas ;
 *   • une pièce déclarée confidentielle exige ses lecteurs : c'est ce qui la rend confidentielle.
 */

/** Ce que la personne a touché avant de changer de pièce : une valeur, ou des identifiants (parties). */
export type Gardes = Partial<Record<string, string | string[]>>;

const CHAMPS_LUS: readonly string[] = ["title", "reference", "kind", "startDate", "endDate", "amount", "direction", "notes", "chainFromId"];

export function champsPreremplis(
  base: readonly FieldDef[],
  p: PrerempliDocumentLegal | null,
  gardes: Gardes,
  confidentiel: boolean,
): FieldDef[] {
  const out: FieldDef[] = [];
  const garde = (name: string): string | undefined => { const g = gardes[name]; return typeof g === "string" ? g : undefined; };
  const lue = (name: string): string | undefined => (p && CHAMPS_LUS.includes(name) ? p.valeurs[name as ChampPrerempli] : undefined);

  for (const f of base) {
    switch (f.type) {
      case "hidden":
      case "file":
      case "drivepicker":
      case "checkbox":
        out.push(f);
        break;
      case "parties": {
        const g = gardes[f.name];
        const ids = Array.isArray(g) ? g : p?.partie.retenue ? [p.partie.retenue] : f.defaultValue ?? [];
        const propose = p && !Array.isArray(g) && !p.partie.retenue && (p.partie.candidats.length > 0 || p.partie.aCreer?.nom)
          ? { candidats: p.partie.candidats, phrase: p.partie.phrase, contact: p.partie.aCreer }
          : undefined;
        out.push({ ...f, defaultValue: ids, propose });
        break;
      }
      case "multiselect": {
        const g = gardes[f.name];
        const avecGarde = Array.isArray(g) ? { ...f, defaultValue: g } : f;
        out.push(f.name === "readerId" && confidentiel
          ? { ...avecGarde, required: true, hint: "Document confidentiel : choisissez qui pourra l'ouvrir. Personne d'autre ne le verra, ni dans la liste, ni par son lien." }
          : avecGarde);
        break;
      }
      case "select": {
        if (f.name === "direction" && p?.sensExige && garde(f.name) === undefined) {
          out.push(
            { ...f, defaultValue: "", placeholder: "— Reçue ou émise ? —", hint: "La pièce ne permet pas de dire qui l'a émise : choisissez." },
            { type: "hidden", name: "sensExige", value: "1" },
          );
          break;
        }
        let options = f.options;
        if (f.name === "chainFromId") {
          if (p?.bcSuivi && !options.some((o) => o.value === p.bcSuivi!.value)) options = [p.bcSuivi, ...options];
        }
        const v = garde(f.name) ?? lue(f.name);
        out.push({ ...f, options, ...(v !== undefined ? { defaultValue: v } : {}) });
        break;
      }
      default: {
        const v = garde(f.name) ?? lue(f.name);
        out.push(v !== undefined ? { ...f, defaultValue: v } : f);
        // Le menu « Fait suite à » n'existe que s'il a des pièces à proposer ; le BC cité par la facture lui en donne une.
        if (f.name === "notes" && p?.bcSuivi && !base.some((x) => x.type !== "hidden" && x.name === "chainFromId")) {
          out.push({
            type: "select", name: "chainFromId", label: "Fait suite à (devis, bon de commande…)", full: true,
            options: [p.bcSuivi], placeholder: "— Pièce isolée —", defaultValue: garde("chainFromId") ?? p.bcSuivi.value,
            hint: "Un bon de commande suit son devis ; une facture suit son bon de commande. La fiche montrera la chaîne entière.",
          });
        }
      }
    }
  }
  return out;
}

/** Les marques à montrer : celles de la lecture, moins les champs que la personne a déjà faits siens. */
export function marquesAffichees(p: PrerempliDocumentLegal | null, gardes: Gardes): Partial<Record<string, MarqueDeChamp>> {
  if (!p) return {};
  const out: Partial<Record<string, MarqueDeChamp>> = {};
  for (const [name, m] of Object.entries(p.marques)) if (m && gardes[name] === undefined) out[name] = m;
  return out;
}
