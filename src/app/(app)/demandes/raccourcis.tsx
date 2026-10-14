"use client";

import * as React from "react";
import Link from "next/link";
import { Receipt, Car, Trash2 } from "lucide-react";
import { Sheet } from "@/components/ui/sheet";
import { ExpenseAckList, type ExpenseAckItem } from "./expense-ack";

/**
 * LES RACCOURCIS DU BUREAU — ce qui attend AILLEURS que dans le tableau : les originaux des notes de
 * frais à réceptionner (la liste s'ouvre ici, en panneau), les courses chauffeur encore en cours, la
 * corbeille. Une pastille qui compte, pas une barre de six boutons permanente : on y va quand le
 * chiffre le demande.
 */
const pastille = "inline-flex min-h-9 items-center gap-1.5 rounded-full border border-border bg-card px-3 text-xs font-semibold hover:bg-secondary sm:min-h-8";

export function RaccourcisBureau({ notesDeFrais, coursesEnCours }: { notesDeFrais: ExpenseAckItem[]; coursesEnCours: number }) {
  const [ouvert, setOuvert] = React.useState(false);
  return (
    <nav aria-label="À traiter ailleurs" className="flex flex-wrap gap-2">
      <button type="button" className={pastille} onClick={() => setOuvert(true)} disabled={notesDeFrais.length === 0}>
        <Receipt className="h-3.5 w-3.5 text-muted-foreground" /> Notes de frais — originaux à réceptionner
        <span className={notesDeFrais.length ? "text-warning" : "text-muted-foreground"}>{notesDeFrais.length}</span>
      </button>
      <Link href="/demandes/courses" className={pastille}>
        <Car className="h-3.5 w-3.5 text-muted-foreground" /> Courses en cours
        <span className={coursesEnCours ? "text-warning" : "text-muted-foreground"}>{coursesEnCours}</span>
      </Link>
      <Link href="/demandes/corbeille" className={pastille}>
        <Trash2 className="h-3.5 w-3.5 text-muted-foreground" /> Corbeille
      </Link>
      <Sheet open={ouvert} onClose={() => setOuvert(false)} title="Notes de frais — originaux à réceptionner" description="Un clic vaut accusé de réception (tracé, notifié à l'employé et aux RH)." width="md">
        <ExpenseAckList items={notesDeFrais} />
      </Sheet>
    </nav>
  );
}
