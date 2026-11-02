import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { FORMATS, LIBELLES_SOURCES, NOMS_FORMATS, SOURCES, type Format, type Segment } from "../partage";

/**
 * L'ÉCRAN DE VÉRIFICATION DE LA BIBLIOTHÈQUE (J1) — une requête, des filtres, des résultats sous les droits.
 * Composants SERVEUR (aucun état) : le formulaire est un GET, les résultats arrivent rendus.
 */

export interface ParamsRecherche {
  q?: string;
  format?: string;
  source?: string;
  du?: string;
  au?: string;
}

export function FormulaireBibliotheque({ p }: { p: ParamsRecherche }) {
  return (
    <form method="get" className="surface grid grid-cols-1 gap-3 p-3 sm:grid-cols-[1fr_auto] sm:p-4">
      <div className="space-y-1">
        <Label htmlFor="q">Chercher par le contenu</Label>
        <Input id="q" name="q" defaultValue={p.q ?? ""} placeholder="« durée de conservation du lot », « contrat de transport frigorifique »…" autoFocus />
      </div>
      <div className="flex items-end">
        <Button type="submit" className="w-full sm:w-auto">Chercher</Button>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:col-span-2 sm:grid-cols-4">
        <div className="space-y-1">
          <Label htmlFor="format">Format</Label>
          <Select id="format" name="format" defaultValue={p.format ?? ""}>
            <option value="">Tous</option>
            {NOMS_FORMATS.map((f) => <option key={f} value={f}>{FORMATS[f]}</option>)}
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="source">Source</Label>
          <Select id="source" name="source" defaultValue={p.source ?? ""}>
            <option value="">Toutes</option>
            {SOURCES.map((s) => <option key={s} value={s}>{LIBELLES_SOURCES[s]}</option>)}
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="du">Du</Label>
          <Input id="du" name="du" type="date" defaultValue={p.du ?? ""} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="au">Au</Label>
          <Input id="au" name="au" type="date" defaultValue={p.au ?? ""} />
        </div>
      </div>
    </form>
  );
}

export interface ResultatAffiche {
  pieceId: string;
  titre: string;
  format: Format;
  source: keyof typeof LIBELLES_SOURCES;
  date: Date;
  confidentiality: "INTERNAL" | "RESTRICTED" | "CONFIDENTIAL";
  sensible: boolean;
  endroit: { libelle: string; lien: string };
  extrait: Segment[];
}

const DATE = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "short", year: "numeric", timeZone: "Africa/Algiers" });

function Extrait({ segments }: { segments: Segment[] }) {
  if (!segments.length) return null;
  return (
    <p className="text-sm text-muted-foreground">
      {segments.map((s, i) => (s.fort ? <mark key={i} className="rounded bg-warning/20 px-0.5 text-foreground">{s.texte}</mark> : <span key={i}>{s.texte}</span>))}
    </p>
  );
}

export function ResultatsBibliotheque({ resultats, requete }: { resultats: ResultatAffiche[]; requete: string }) {
  if (!resultats.length) {
    return (
      <p className="surface p-4 text-sm text-muted-foreground">
        {requete ? "Aucune pièce que vous pouvez ouvrir ne correspond à cette recherche." : "Aucune pièce lue pour l'instant parmi celles que vous pouvez ouvrir."}
      </p>
    );
  }
  return (
    <ul className="space-y-2">
      {resultats.map((r) => (
        <li key={r.pieceId} className="surface space-y-1.5 p-3 sm:p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Link href={r.endroit.lien} className="min-w-0 break-words font-medium text-primary underline-offset-2 hover:underline">{r.titre}</Link>
            <Badge>{FORMATS[r.format] ?? r.format}</Badge>
            <Badge>{r.endroit.libelle}</Badge>
            {r.confidentiality === "CONFIDENTIAL" && <Badge tone="warning">Confidentiel</Badge>}
            {r.sensible && <Badge tone="warning">Pièce du coffre</Badge>}
            <span className="text-xs text-muted-foreground">{LIBELLES_SOURCES[r.source]} · {DATE.format(r.date)}</span>
          </div>
          <Extrait segments={r.extrait} />
        </li>
      ))}
    </ul>
  );
}
