"""영수증 합계 계산.

규칙: 쿠폰은 부가세를 붙이기 **전에** 빼고, 최종 금액은 원 단위로 반올림한다.
합계는 0 보다 작아질 수 없다.
"""

TAX_RATE = 0.1


def line_total(item):
    return item["price"] * item["count"]


def subtotal(items):
    return sum(line_total(item) for item in items)


def total(items, coupon=0):
    # 버그 1: 쿠폰을 부가세 계산 뒤에 뺀다 (규칙은 부가세 전)
    # 버그 2: 반올림 대신 버림(int)을 쓴다
    # 버그 3: 쿠폰이 크면 음수가 된다
    return int(subtotal(items) * (1 + TAX_RATE) - coupon)
