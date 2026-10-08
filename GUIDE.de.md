# Anleitung

> **Wichtig für Fehler-Reports:** Schalte unten auf der Seite den **Diagnose-Log** ein, *bevor* du dich mit dem Scooter verbindest. Nur dann wird der komplette Verbindungsaufbau mitgeschnitten - und genau diese Zeilen brauchen wir in einem [Ticket](https://github.com/Laufbursche42/Laufbursche42/issues), um ein Problem nachzuvollziehen.

## Was du brauchst
- Einen KUKIRIN (Kugoo) E-Scooter.
- Ein Handy oder einen Rechner mit **Chrome**, **Edge** oder auf iOS **Bluefy**. Safari und Firefox können kein Web Bluetooth.

## Verbinden
1. Bluetooth am Gerät einschalten, den Scooter einschalten (wecken).
2. Auf **Verbinden** tippen und den Scooter in der Liste auswählen.
3. Taucht er nicht auf, setze den Haken bei **Alle Geräte zeigen** und verbinde erneut. Die Seite probiert drei GATT-Profile durch und nimmt das, dessen Schreib-Charakteristik vorhanden ist.
4. Verlangt dein Dashboard noch den alten Klartext-Code, trage ihn vor dem Verbinden in das Feld **Kopplungscode** ein. Hast du keinen, lass es leer.
5. Nach dem Verbinden erscheinen die Karten für Live-Werte, Sperre, Geschwindigkeit und Einstellungen.

## Live-Werte lesen
Der Scooter sendet laufend seinen Status und auf Abfrage seinen Modellcode (imoogoo-...), den die Seite in den Modellnamen übersetzt. Jede Kachel erscheint, sobald ihr Wert angekommen ist; ein Strich heißt nur, dass dieser Wert noch nicht kam. Unter den Kacheln kannst du mit **Alle empfangenen Frames** die Rohdaten pro Opcode mitlesen. Sperre, Licht und Einheit stecken in Status-Bits und erscheinen daher nur als Rohdaten, nicht als eigene Kachel.

## Geschwindigkeit setzen
- **Entsperren** schreibt den Wert aus dem Feld **Offen**, **Sperren** den Wert aus **eKFV / legal**, beide in das Register +SPDLT.
- Mit **Genau setzen** schreibst du einen beliebigen km/h-Wert direkt.
- Ein Limit-Wert kommt über Bluetooth nicht zurück, darum schaltet der Knopf bei jedem Druck manuell zwischen Entsperren und Sperren um.
- Wichtig: Ein Echo im Log heißt nur, dass der Scooter das Frame angenommen hat. Ob die Firmware mehr als die legal erlaubten km/h akzeptiert, musst du an deinem Gerät ausprobieren. Die Gang-Entdrosselung (+MDMX) wird von der App nur gelesen, nicht geschrieben, darum bietet die Seite sie nicht an.

## Elektronische Sperre
In der Karte **Elektronische Sperre** hebst du die Sperre auf (+LOCK=0). Das Sperren selbst läuft modellabhängig über einen Passwort-Frame und ist hier bewusst nicht nachgebaut.

## Weitere Einstellungen
Licht, Einheit (km/mi), Anfahrsperre, Tempomat, Geschwindigkeitsbegrenzung, Bremskraft, Anfahrkraft, Display-Helligkeit und Beleuchtungsdauer. Das sind reine Schreibbefehle, der Scooter meldet ihren Zustand nicht zurück.

## Erweiterte Einstellungen (Engine-Ebene)
**Rohes Frame** sendet deine Hex-Bytes unverändert. **Frame bauen** nimmt Opcode und Payload und ergänzt AA-Marker und XOR-Prüfsumme selbst. **AT-Textbefehl** sendet einen +CMD-String als UTF-8.

## Shortcuts
Kopiere den Link auf den Startbildschirm, dann ent- oder sperrt ein Tipp direkt. Auf iOS über Bluefy, und der Scooter muss vorher einmal normal verbunden gewesen sein.

## Wenn etwas nicht geht
- Kein Verbinden? Prüfe, dass der Browser Web Bluetooth kann, Bluetooth an ist und der Scooter wach ist. Mit **Alle Geräte zeigen** erneut versuchen.
- Nichts passiert nach einem Befehl? Schau ins Log: steht dort "gesendet", hat die Seite das Frame geschrieben. Ob die Firmware es umgesetzt hat, zeigt erst das Verhalten des Rollers.
- Verlangt der Roller die neuere gegenseitige Authentisierung (+PM), kann diese Seite sie nicht abschließen, weil die dafür nötigen Schlüssel nicht im Protokoll offenliegen.
- **Diagnose: alle Geräte auflisten** im Log-Bereich zeigt alle Bluetooth-Dienste eines Geräts, ohne etwas zu schreiben - hilfreich für Support.

## Mithelfen
Willst du herausfinden, ob und wie Tuning bei deinem Scooter geht? Teste dieses Tool an deinem eigenen Fahrzeug und öffne ein Ticket auf [GitHub](https://github.com/Laufbursche42/Laufbursche42/issues) - mit deinem Modell und was funktioniert hat (oder nicht). So finden wir gemeinsam heraus, was bei welchem Modell möglich ist.
