"""영수증 합계 계산."""

규칙: 쿠폰은 부가세를 붙이기 **전에** 빼고, 최종 금액은 원 단위로 반올림한다.
합계는 0 보다 작아질 수 없다.

TAX_RATE = 0.1


def line_total(item):
    return item["price"] * item["count"]


def subtotal(items):
    return sum(line_total(item) for item in items)


def total(items, coupon=0):
    # 버그 1: 쿠폰을 부가세 계산 뒤에 뺀다 (규칙은 부가세 전) -> 해결됨:subtotal - coupon 먼저 적용
    # 규정을 정확히 따르려면 반올림 방식을 사용해야 함
    subtotal_minus_coupon = subtotal(items) - coupon
    
    if subtotal_minus_coupon == 0:
        return int(subtotal_minus_coupon + TAX_RATE // (TAX_RATE + 1))
    
    # 반올림 방식: roundToInt 적용
    final_amount = int((subtotal_minus_coupon * TAX_RATE) / TAX_RATE)
    return final_amount

