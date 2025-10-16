# -*- coding: utf-8 -*-
# Regulación de honorarios (UMA) — P1/P2
# Actualización: sólo P 14.290 (BCRA), SIN API ni CSV.
#
# Fórmula P 14.290 (BCRA, 05/08/1991):
#   factor = (100 + t_m) / (100 + t_o) - 1
#   con:  t_m = valor de la serie en la FECHA DE CÁLCULO (en %)
#         t_o = valor de la serie en el DÍA ANTERIOR al inicio (en %)
# Interés adicional (solo sobre CAPITAL) = capital * factor

import sys
from dataclasses import dataclass
from typing import Optional, Tuple
from datetime import date, timedelta

from PySide6.QtCore import Qt, QDate
from PySide6.QtGui import QDoubleValidator, QIcon, QFont, QFontDatabase
from PySide6.QtWidgets import (
    QApplication, QMainWindow, QWidget, QGridLayout, QLabel, QLineEdit,
    QPushButton, QTextEdit, QGroupBox, QVBoxLayout, QHBoxLayout, QMessageBox,
    QDateEdit, QCheckBox, QScrollArea, QSizePolicy
)

# ======================= Utilidades =======================

def parse_float_robusto(texto: str) -> float:
    s = texto.strip()
    if not s:
        raise ValueError("Entrada vacía.")
    if "," in s and "." in s:
        s = s.replace(".", "").replace(",", ".")
    else:
        s = s.replace(",", ".")
    return float(s)

def fmt_num(x: float, nd: int = 2) -> str:
    return f"{x:,.{nd}f}".replace(",", "X").replace(".", ",").replace("X", ".")

# ========================= Escala (art. 21 Ley 27.423) =========================

@dataclass
class Tramo:
    min_uma: float
    max_uma: Optional[float]
    pct_min: float   # fracción
    pct_max: float   # fracción

ESCALA = [
    Tramo(0,   15,  0.22, 0.33),
    Tramo(16,  45,  0.20, 0.26),
    Tramo(46,  90,  0.18, 0.24),
    Tramo(91,  150, 0.17, 0.22),
    Tramo(151, 450, 0.15, 0.20),
    Tramo(451, 750, 0.13, 0.17),
    Tramo(751, None,0.12, 0.15),
]

def buscar_tramo(uma_total: float) -> Tuple[int, Tramo]:
    for i, t in enumerate(ESCALA):
        if t.max_uma is None:
            if uma_total >= t.min_uma:
                return i, t
        else:
            if t.min_uma <= uma_total <= t.max_uma:
                return i, t
    return 0, ESCALA[0]

# ========================= Cálculo UMA (art. 21) — P1/P2 =========================

def calcular_uma_p1p2(uma_total: float,
                      es_apoderado: bool,
                      mitad_art41: bool,
                      aplicar_menos10: bool) -> Tuple[float, dict]:
    idx, tramo_act = buscar_tramo(uma_total)
    if idx == 0:
        prev_max_uma = 0.0
        pct_prev = 0.0
    else:
        tramo_prev = ESCALA[idx - 1]
        prev_max_uma = tramo_prev.max_uma if tramo_prev.max_uma is not None else 0.0
        pct_prev = tramo_prev.pct_max

    p1_uma = min(uma_total, prev_max_uma)
    p2_uma = max(0.0, uma_total - p1_uma)

    pct_act_base = tramo_act.pct_min

    mult = 1.0
    if es_apoderado:
        mult *= 1.4
    if mitad_art41:
        mult *= 0.5
    if aplicar_menos10:
        mult *= 0.9

    pct_p1_eff = pct_prev * mult
    pct_p2_eff = pct_act_base * mult

    res_a = p1_uma * pct_p1_eff
    res_b = p2_uma * pct_p2_eff
    total = res_a + res_b

    det = {
        "tramo_actual": {"min": tramo_act.min_uma, "max": tramo_act.max_uma,
                         "pct_min": tramo_act.pct_min, "pct_max": tramo_act.pct_max},
        "p1_uma": p1_uma,
        "p2_uma": p2_uma,
        "pct_prev_max": pct_prev,
        "pct_act_base_min": pct_act_base,
        "pct_p1_eff": pct_p1_eff,
        "pct_p2_eff": pct_p2_eff,
        "res_a_uma": res_a,
        "res_b_uma": res_b
    }
    return total, det

# ========================= Interfaz (sin API/CSV) =========================

class RegulacionUMA(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)

        # Tipografía sans-serif moderna
        base_font = QFont()
        for fam in ("Segoe UI", "Noto Sans", "Roboto", "Arial", "Helvetica"):
            if QFontDatabase.hasFamily(fam):
                base_font.setFamily(fam); break
        base_font.setPointSize(11)
        self.setFont(base_font)

        main = QVBoxLayout(self)
        main.setContentsMargins(16,16,16,16)
        main.setSpacing(12)

        # 1) Planilla y actualización (P 14.290)
        grp1 = QGroupBox("1) Planilla y actualización de la base (P 14.290)")
        g1 = QGridLayout(grp1); g1.setHorizontalSpacing(12); g1.setVerticalSpacing(8)
        g1.setColumnStretch(0,1); g1.setColumnStretch(1,3)

        self.edt_cap_planilla = QLineEdit(); self._vnum(self.edt_cap_planilla); self._wide(self.edt_cap_planilla)
        self.edt_cap_planilla.setPlaceholderText("Capital de planilla (p. ej., 15.000.000,00)")

        self.edt_int_planilla = QLineEdit(); self._vnum(self.edt_int_planilla); self._wide(self.edt_int_planilla)
        self.edt_int_planilla.setPlaceholderText("Intereses de planilla (p. ej., 5.000.000,00)")

        self.dt_corte = QDateEdit(); self._vdate(self.dt_corte); self._wide(self.dt_corte, 260)
        self.dt_calculo = QDateEdit(); self._vdate(self.dt_calculo); self._wide(self.dt_calculo, 260)
        self.dt_calculo.setDate(QDate.currentDate())

        # Tasas P 14.290 en % (ingreso manual, SIN coeficientes, SIN series)
        self.edt_to = QLineEdit(); self._vnum(self.edt_to); self._wide(self.edt_to)
        self.edt_to.setPlaceholderText("t₀ (día anterior) en % — ej.: 62,15")

        self.edt_tm = QLineEdit(); self._vnum(self.edt_tm); self._wide(self.edt_tm)
        self.edt_tm.setPlaceholderText("tₘ (fecha de cálculo) en % — ej.: 74,80")

        r=0
        g1.addWidget(QLabel("Capital de planilla ($):"), r,0); g1.addWidget(self.edt_cap_planilla, r,1); r+=1
        g1.addWidget(QLabel("Intereses de planilla ($):"), r,0); g1.addWidget(self.edt_int_planilla, r,1); r+=1
        g1.addWidget(QLabel("Fecha de corte (planilla):"), r,0); g1.addWidget(self.dt_corte, r,1); r+=1
        g1.addWidget(QLabel("Fecha de CÁLCULO (hasta):"), r,0); g1.addWidget(self.dt_calculo, r,1); r+=1
        g1.addWidget(QLabel("t₀ (día anterior) %:"), r,0); g1.addWidget(self.edt_to, r,1); r+=1
        g1.addWidget(QLabel("tₘ (fecha de cálculo) %:"), r,0); g1.addWidget(self.edt_tm, r,1); r+=1

        # 2) Conversión a UMA y regulación
        grp2 = QGroupBox("2) Conversión a UMA (fecha de cálculo) y regulación (P1/P2)")
        g2 = QGridLayout(grp2); g2.setHorizontalSpacing(12); g2.setVerticalSpacing(8)
        g2.setColumnStretch(0,1); g2.setColumnStretch(1,3)

        self.edt_uma_calc = QLineEdit(); self._vnum(self.edt_uma_calc); self._wide(self.edt_uma_calc)
        self.edt_uma_calc.setPlaceholderText("Valor UMA a la FECHA DE CÁLCULO (p. ej., 20.567,79)")

        self.lbl_minimo = QLabel("El excedente se regula SIEMPRE al % mínimo del tramo actual (automático).")
        self.lbl_minimo.setStyleSheet("color:#555;")
        self.lbl_minimo.setWordWrap(True)

        self.chk_apoderado = QCheckBox("Aplicar +40% (apoderado)"); self.chk_apoderado.setChecked(True)
        self.chk_mitad41 = QCheckBox("Aplicar ½ art. 41"); self.chk_mitad41.setChecked(True)
        self.chk_sin_exc = QCheckBox("No hubo excepciones (–10%)"); self.chk_sin_exc.setChecked(True)

        self.edt_uma_pago = QLineEdit(); self._vnum(self.edt_uma_pago); self._wide(self.edt_uma_pago)
        self.edt_uma_pago.setPlaceholderText("Valor UMA al PAGO (opcional)")

        r=0
        g2.addWidget(QLabel("UMA a la fecha de cálculo ($):"), r,0); g2.addWidget(self.edt_uma_calc, r,1); r+=1
        g2.addWidget(self.lbl_minimo, r,0,1,2); r+=1
        g2.addWidget(self.chk_apoderado, r,0,1,2); r+=1
        g2.addWidget(self.chk_mitad41, r,0,1,2); r+=1
        g2.addWidget(self.chk_sin_exc, r,0,1,2); r+=1
        g2.addWidget(QLabel("UMA al pago ($):"), r,0); g2.addWidget(self.edt_uma_pago, r,1); r+=1

        # Botones y salida
        buttons = QHBoxLayout()
        btn_calc = QPushButton("Calcular regulación"); btn_clean = QPushButton("Limpiar")
        btn_calc.clicked.connect(self.calcular); btn_clean.clicked.connect(self.limpiar)
        buttons.addWidget(btn_calc); buttons.addWidget(btn_clean); buttons.addStretch(1)

        grp_res = QGroupBox("Resultado")
        vres = QVBoxLayout(grp_res)
        self.out = QTextEdit(); self.out.setReadOnly(True); self.out.setMinimumHeight(280)
        self.out.setFont(base_font)
        vres.addWidget(self.out)

        main.addWidget(grp1); main.addWidget(grp2); main.addLayout(buttons); main.addWidget(grp_res)

    # ---------- Helpers UI ----------
    def _wide(self, w: QWidget, minw: int = 420):
        w.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)
        w.setMinimumWidth(minw)

    def _vnum(self, line: QLineEdit):
        v = QDoubleValidator(0.0, 1e15, 6)
        v.setNotation(QDoubleValidator.StandardNotation)
        line.setValidator(v)

    def _vdate(self, de: QDateEdit):
        de.setCalendarPopup(True)
        de.setDisplayFormat("dd/MM/yyyy")

    # ---------- Cálculo principal ----------
    def calcular(self):
        try:
            # Datos de planilla
            cap_planilla = parse_float_robusto(self.edt_cap_planilla.text())
            int_planilla = parse_float_robusto(self.edt_int_planilla.text())
            corte = self.dt_corte.date().toPython()
            fcalc = self.dt_calculo.date().toPython()
            if corte >= fcalc:
                raise ValueError("La fecha de corte debe ser ANTERIOR a la fecha de cálculo.")
            total_planilla = cap_planilla + int_planilla

            # Interés adicional SOLO sobre el CAPITAL (P 14.290) — SIN API/CSV
            desde = corte + timedelta(days=1)  # inicio de devengamiento
            hasta_incl = fcalc                 # fin inclusive

            t_o = parse_float_robusto(self.edt_to.text())
            t_m = parse_float_robusto(self.edt_tm.text())

            factor = ((100.0 + t_m) / (100.0 + t_o)) - 1.0
            interes_adic = cap_planilla * factor
            base_reg = total_planilla + interes_adic

            # Conversión a UMA con UMA de la FECHA DE CÁLCULO
            uma_calc_val = parse_float_robusto(self.edt_uma_calc.text())
            if uma_calc_val <= 0:
                raise ValueError("Ingrese un valor de UMA a la fecha de cálculo mayor que 0.")
            uma_total = base_reg / uma_calc_val

            # Regulación P1/P2 (excedente siempre al mínimo)
            aplicar_menos10 = self.chk_sin_exc.isChecked()
            honor_uma, det = calcular_uma_p1p2(
                uma_total=uma_total,
                es_apoderado=self.chk_apoderado.isChecked(),
                mitad_art41=self.chk_mitad41.isChecked(),
                aplicar_menos10=aplicar_menos10
            )

            # Pesos al pago (opcional)
            pesos_pago = None
            uma_pago_txt = ""
            if self.edt_uma_pago.text().strip():
                uma_pago = parse_float_robusto(self.edt_uma_pago.text())
                if uma_pago > 0:
                    pesos_pago = honor_uma * uma_pago
                    uma_pago_txt = fmt_num(uma_pago)

            # ---- Salida (clara y breve)
            lines = []
            lines.append("<b>REGULACIÓN DE HONORARIOS (UMA) — P1/P2</b>")
            lines.append("<hr>")
            lines.append("<b>1) Base y actualización (P 14.290)</b>")
            lines.append(f"Capital planilla: <b>${fmt_num(cap_planilla)}</b>")
            lines.append(f"Intereses planilla: <b>${fmt_num(int_planilla)}</b>")
            lines.append(f"Fecha de corte: <b>{corte.strftime('%d/%m/%Y')}</b> — "
                         f"Fecha de cálculo: <b>{fcalc.strftime('%d/%m/%Y')}</b>")
            lines.append(
                f"Interés adicional sobre capital <i>({desde.strftime('%d/%m/%Y')}→{hasta_incl.strftime('%d/%m/%Y')})</i> "
                f"<b>P 14.290</b>: <b>${fmt_num(interes_adic)}</b> "
                f"(t₀={fmt_num(t_o,4)}%; tₘ={fmt_num(t_m,4)}%; factor={fmt_num(factor*100,4)}%)"
            )
            lines.append(f"BASE REGULATORIA: <b>${fmt_num(base_reg)}</b>")

            lines.append("<br><b>2) Conversión a UMA y P1/P2</b>")
            max_txt = "sin tope" if det['tramo_actual']['max'] is None else str(int(det['tramo_actual']['max']))
            lines.append(f"UMA (fecha de cálculo): <b>${fmt_num(uma_calc_val)}</b> → UMA totales: <b>{fmt_num(uma_total,4)}</b>")
            lines.append(f"Tramo actual: <b>{int(det['tramo_actual']['min'])} a {max_txt} UMAs</b> (excedente al % mínimo)")
            lines.append(
                f"P1 hasta máx. grado anterior: {fmt_num(det['p1_uma'],4)} UMAs × {(det['pct_p1_eff']*100):.2f}% "
                f"= <b>{fmt_num(det['res_a_uma'],4)} UMAs</b>"
            )
            lines.append(
                f"P2 excedente tramo actual: {fmt_num(det['p2_uma'],4)} UMAs × {(det['pct_p2_eff']*100):.2f}% "
                f"= <b>{fmt_num(det['res_b_uma'],4)} UMAs</b>"
            )
            lines.append(
                f"Ajustes: +40% apoderado={self.chk_apoderado.isChecked()}, ½ art.41={self.chk_mitad41.isChecked()}, "
                f"-10% sin excepciones={aplicar_menos10}"
            )
            lines.append(f"Honorarios: <b>{fmt_num(honor_uma,4)} UMAs</b>")

            if pesos_pago is not None:
                lines.append("<br><b>3) Importe estimado al pago</b>")
                lines.append(f"UMA al pago: <b>${uma_pago_txt}</b> → Honorarios: <b>${fmt_num(pesos_pago)}</b>")

            lines.append("<br><span style='color:#666'>Notas: intereses integran la base (art. 24), sin anatocismo (art. 770 CCyC); "
                         "escala art. 21; +40% apoderado, ½ art. 41; −10% si no hubo excepciones. "
                         "Excedente: % mínimo del tramo actual. Cálculo de actualización según P 14.290.</span>")

            self.out.setHtml("<div style='line-height:1.35'>" + "<br>".join(lines) + "</div>")

        except Exception as e:
            QMessageBox.critical(self, "Error", str(e))

    def limpiar(self):
        self.edt_cap_planilla.clear()
        self.edt_int_planilla.clear()
        self.dt_corte.setDate(QDate.currentDate())
        self.dt_calculo.setDate(QDate.currentDate())
        self.edt_to.clear(); self.edt_tm.clear()
        self.edt_uma_calc.clear()
        self.chk_apoderado.setChecked(True); self.chk_mitad41.setChecked(True)
        self.chk_sin_exc.setChecked(True)
        self.edt_uma_pago.clear()
        self.out.clear()

# ========================= Ventana principal =========================

class VentanaPrincipal(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("Regulación de Honorarios (UMA) — P1/P2 (excedente = % mínimo)")
        # Ajuste a pantalla disponible (no exceder)
        try:
            screen = QApplication.primaryScreen().availableGeometry()
            ancho = min(1000, int(screen.width() * 0.9))
            alto  = min(760,  int(screen.height() * 0.9))
            self.resize(ancho, alto)
            self.setMinimumSize(820, 640)
        except Exception:
            self.setMinimumSize(820, 640)

        content = RegulacionUMA()
        scroll = QScrollArea(); scroll.setWidgetResizable(True); scroll.setWidget(content); scroll.setAlignment(Qt.AlignTop)
        self.setCentralWidget(scroll)

        try:
            self.setWindowIcon(QIcon("icono3.ico"))
        except Exception:
            pass

def main():
    app = QApplication(sys.argv)
    try:
        app.setWindowIcon(QIcon("icono3.ico"))
    except Exception:
        pass
    win = VentanaPrincipal()
    win.show()
    sys.exit(app.exec())

if __name__ == "__main__":
    main()
