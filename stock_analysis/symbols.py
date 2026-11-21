"""Resolve A-share equities and mainland indices without confusing 000001."""
from dataclasses import dataclass
import re

SH_INDICES = {"000001", "000016", "000300", "000688", "000852", "000905", "000906", "000985"}


@dataclass(frozen=True)
class Instrument:
    code: str
    market: str
    kind: str

    @property
    def symbol(self):
        return self.market + self.code

    @property
    def secid(self):
        return ("1." if self.market == "sh" else "0.") + self.code

    @property
    def key(self):
        return f"{self.symbol}_{self.kind}"


def resolve_symbol(value, kind="auto"):
    if kind not in {"auto", "stock", "index"}:
        raise ValueError("kind must be auto, stock or index")
    match = re.fullmatch(r"(sh|sz)?(\d{6})", str(value).strip().lower())
    if not match:
        raise ValueError("Use six digits or an sh/sz prefix, e.g. 600519 or sz000001")
    market, code = match.groups()
    if code == "000001" and market is None and kind == "auto":
        raise ValueError("000001 is ambiguous: use sz000001 (stock) or sh000001 (index)")
    if kind == "auto":
        is_index = (
            code.startswith("399")
            or (market == "sh" and code.startswith("000"))
            or (code in SH_INDICES and market != "sz")
        )
        kind = "index" if is_index else "stock"
    if kind == "index":
        expected = "sz" if code.startswith("399") else "sh" if code.startswith("000") else None
    else:
        expected = "sh" if code.startswith(("600", "601", "603", "605", "688", "689")) else "sz" if code.startswith(("000", "001", "002", "003", "300", "301")) else None
    if expected is None or (market and market != expected):
        raise ValueError(f"Unsupported market/code combination for {kind}: {value}")
    return Instrument(code, expected, kind)
