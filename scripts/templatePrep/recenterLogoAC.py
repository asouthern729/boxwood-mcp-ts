#!/usr/bin/env python3
"""Follow-up to resizeCenterLogo.py (client feedback, 2026-09-15: "i still want the logo centered
between A and C just at the largest size it can be" -- the previous attempt centered it across the
full A-H content width instead, which visually reads as shifted well to the right since column B
alone (60 units wide) is nearly a third of that whole span).

Recentering target: columns A-C only (539px / 5,133,975 EMU total), not the full A-H table width.
Size is UNCHANGED from resizeCenterLogo.py (3110884x850000 EMU) -- that size was already governed by
the vertical headroom above row 6 ("Insured Name:"), not by how wide the centering target is, and
895350 EMU of headroom is still more than enough width-wise to fit inside A-C alone (3110884 <
5133975), so "largest size it can be" is still this same height-constrained size.

New horizontal center: (5133975 - 3110884) / 2 = 1011545.5 EMU from the sheet's left edge -- column A
is 200025 EMU wide, so this falls 811520 EMU into column B (not column C as the previous, wider A-H
centering target computed).
"""
import zipfile
import shutil

TEMPLATE_PATH = "assets/templates/commercial-renewal-template.xlsx"

NEW_FROM_COL = 1        # column B (0-indexed)
NEW_FROM_COL_OFF = 811520

OLD_FROM = '<xdr:from><xdr:col>2</xdr:col><xdr:colOff>411471</xdr:colOff><xdr:row>0</xdr:row><xdr:rowOff>200025</xdr:rowOff></xdr:from><xdr:ext cx="3110884" cy="850000"/>'
NEW_FROM = f'<xdr:from><xdr:col>{ NEW_FROM_COL }</xdr:col><xdr:colOff>{ NEW_FROM_COL_OFF }</xdr:colOff><xdr:row>0</xdr:row><xdr:rowOff>200025</xdr:rowOff></xdr:from><xdr:ext cx="3110884" cy="850000"/>'


def main():
    with zipfile.ZipFile(TEMPLATE_PATH) as z:
        drawing_xml = z.read("xl/drawings/drawing1.xml").decode("utf-8")

    if OLD_FROM not in drawing_xml:
        raise SystemExit("Expected prior resizeCenterLogo.py anchor not found -- template may already be recentered, or changed shape. Aborting without modifying anything.")

    new_xml = drawing_xml.replace(OLD_FROM, NEW_FROM)

    tmp_path = TEMPLATE_PATH + ".tmp"
    with zipfile.ZipFile(TEMPLATE_PATH) as zin, zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if item.filename == "xl/drawings/drawing1.xml":
                data = new_xml.encode("utf-8")
            zout.writestr(item, data)

    shutil.move(tmp_path, TEMPLATE_PATH)
    print(f"Recentered logo within columns A-C: col {NEW_FROM_COL}+{NEW_FROM_COL_OFF} EMU, in {TEMPLATE_PATH}")


if __name__ == "__main__":
    main()
