"""Parse benchmark formula syntax separately from instrument resolution and trust."""
from functools import lru_cache
import json
from pathlib import Path
import re
import unicodedata

PERCENT = r"(\d{1,3}(?:\.\d+)?)%"
PREFIX_WEIGHT = re.compile(r"^" + PERCENT + r"\s*[×*]\s*(.+)$")
SUFFIX_WEIGHT = re.compile(r"^(.+?)\s*[×*]\s*" + PERCENT + r"$")
FIXED_RATE = re.compile("^" + PERCENT + r"(\(.*\))?$")
INDEX = re.compile(r"^[\w&/·.\-ー—－()]+指数(?:\([^%+*=]*\))*$")
DEPOSIT = re.compile(r"^(?:该封闭期起始日的|同期)?[\w()\-]*(?:活期存款|定期存款|储蓄存款|同业存款)[\w()\-]*利率[\w()\-]*$")
CURRENCY_MARKERS = {"人民币":"CNY", "港元":"HKD", "港币":"HKD", "美元":"USD", "欧元":"EUR", "日元":"JPY"}
BASIS_MARKERS = {"净总收益":"net_total_return", "全收益":"total_return", "总收益":"total_return",
                 "总回报":"total_return", "财富":"total_return", "全价":"full_price", "净价":"net_price",
                 "价格":"price"}


def compact(text):
    value = unicodedata.normalize("NFKC", text)
    return re.sub(r"\s+", "", value).strip("。；;").replace("–", "-").replace("－", "-")


def split_components(value):
    parts = []
    depth = start = 0
    for i, char in enumerate(value):
        if char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
            if depth < 0:
                raise ValueError("unbalanced_parentheses")
        elif char == "+" and depth == 0:
            parts.append(value[start:i])
            start = i + 1
    if depth:
        raise ValueError("unbalanced_parentheses")
    parts.append(value[start:])
    if not all(parts) or len(parts) > 12:
        raise ValueError("invalid_term_count")
    return parts


@lru_cache(maxsize=1)
def index_catalog():
    return json.loads(Path(__file__).with_name("fund_benchmark_indices.json").read_text(encoding="utf-8"))


def resolve_index(name, basis, currency):
    codes = [row for row in index_catalog() if name in row["aliases"]]
    if not codes:
        return {"status":"unmapped"}
    matches = [row for row in codes
               if (not basis or row["basis"] == basis) and (not currency or row.get("currency") == currency)]
    if not matches:
        return {"status":"variant_conflict","candidates":[row["id"] for row in codes]}
    if len(matches) != 1:
        return {"status":"ambiguous","candidates":[row["id"] for row in matches]}
    row = matches[0]
    return {"status":"matched",**{key:value for key,value in row.items() if key != "aliases"}}


def index_component(body):
    currency = None
    fx = None
    for label, code in CURRENCY_MARKERS.items():
        if re.search(r"^经" + label + r"汇率调整的", body):
            fx = {"target_currency":code,"method":"unspecified"}
            body = re.sub(r"^经" + label + r"汇率调整的", "", body)
            break
        prefixed = re.match(r"^(?:以)?" + label + r"计价的?", body)
        if prefixed:
            currency = code
            body = body[prefixed.end():]
            break
        if body.endswith("(" + label + ")"):
            currency = code
            body = body[:-(len(label)+2)]
            break
    if body.endswith("(使用估值汇率折算)"):
        body = body.removesuffix("(使用估值汇率折算)")
        fx = {"method":"valuation_fx"}
        if currency:
            fx["target_currency"] = currency
            currency = None
    if not INDEX.fullmatch(body) or body.count("(") != body.count(")"):
        raise ValueError("unsupported_term")
    name = body
    if body == "标普500净总收益指数(S&P500Index(NetTR))":
        name = "标普500净总收益指数"
    basis = next((kind for marker, kind in BASIS_MARKERS.items() if marker in name), None)
    if re.search(r"IndexER\)$|ER指数", name):
        basis = "excess_return"
    if basis == "excess_return" and "(美元)ER指数" in name:
        currency = "USD"
    return {"type":"index","name":name,"basis":basis,"currency":currency,"fx":fx,
            "mapping":resolve_index(name,basis,currency)}


def parse_term(term):
    a = PREFIX_WEIGHT.fullmatch(term)
    b = SUFFIX_WEIGHT.fullmatch(term)
    body, weight = term, None
    if a or b:
        body, number = (a[2], a[1]) if a else (b[1], b[2])
        weight = float(number)/100
        if not 0 < weight <= 1:
            raise ValueError("weight_out_of_range")
    elif re.search(r"[×*](?:\(?\d+(?:\.\d+)?\)?|\(?1?-?[Xx]\)?)$",term) or "%" in term and "X" in term.upper():
        if "X" in term.upper():
            raise ValueError("variable_weights")
        raise ValueError("missing_percentage_marker")

    fixed = FIXED_RATE.fullmatch(body)
    if fixed and weight is None:
        rate = float(fixed[1])/100
        if not 0 <= rate <= 1:
            raise ValueError("rate_out_of_range")
        description = fixed[2]
        return {"type":"fixed_rate","rate":rate,
                "rate_basis":"annual" if description and any(label in description for label in ("年收益率", "年化收益率")) else None,
                "description":description}
    if DEPOSIT.fullmatch(body):
        component = {"type":"deposit_rate","name":body,
                     "tax_basis":"after_tax" if "税后" in body else "before_tax" if "税前" in body else None,
                     "timing":"closed_period_start" if body.startswith("该封闭期起始日") else
                         "contemporaneous" if body.startswith("同期") else None}
    else:
        component = index_component(re.sub(r"(?:收益率|回报率|涨跌幅)$", "", body))
    return {**component,"weight":weight}


def parse_formula(original):
    value = compact(original) if isinstance(original,str) else ""
    prefix = re.match(r"^(?:本基金(?:的)?)?(?:业绩比较基准|基金比较基准)(?:为|[:：])", value)
    if prefix:
        value = value[prefix.end():].lstrip(":")
    try:
        if not value or len(value)>1200:
            raise ValueError("empty_or_oversized_formula")
        if value.startswith("(") and value.endswith(")") and len(split_components(value)) == 1:
            value = value[1:-1]
        annual = re.fullmatch(r"(?:固定)?(?:年化收益率|年收益率)(?:为|:)" + PERCENT, value)
        if annual:
            value = f"{annual[1]}%(指年收益率)"
        if re.search(r"\b[Xx]\b", value):
            raise ValueError("variable_weights")
        components = [parse_term(term) for term in split_components(value)]
        weighted = [item for item in components if item["type"]!="fixed_rate"]
        fixed = len(weighted)!=len(components)
        if len(weighted)==1 and weighted[0]["weight"] is None:
            weighted[0]["weight"] = 1.0
            weighted[0]["weight_origin"] = "sole_component"
        if any(item["weight"] is None for item in weighted):
            raise ValueError("unspecified_weight")
        if weighted and not fixed and abs(sum(item["weight"] for item in weighted)-1)>1e-8:
            raise ValueError("weights_do_not_sum_to_one")
    except ValueError as error:
        return {"status":"unparsed","original":original,"reason":str(error),"components":[]}
    return {"status":"parsed","original":original,"components":components}


def formula_key(parsed):
    if parsed["status"]!="parsed":
        return None
    terms = []
    for term in parsed["components"]:
        mapping = term.get("mapping",{})
        clean = {key:value for key,value in term.items()
                 if key not in {"mapping","weight_origin","description"}}
        if term.get("description"):
            clean["description"] = term["description"].replace("应按期间折算", "按期间折算")
        if mapping.get("status")=="matched":
            clean.update(name=mapping["id"],basis=mapping["basis"],currency=mapping.get("currency"))
        terms.append(json.dumps(clean,sort_keys=True,ensure_ascii=False))
    return tuple(sorted(terms))
