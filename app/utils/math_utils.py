import math

def calculate_line_signed_distance(p1, p2, centroid):
    """
    Calculate signed distance from point to line.
    Returns (signed_dist, is_within_segment)
    """
    x1, y1 = p1
    x2, y2 = p2
    cx, cy = centroid
    
    dx = x2 - x1
    dy = y2 - y1
    line_len_sq = dx * dx + dy * dy
    
    if line_len_sq == 0:
        return 0.0, False
    
    t = ((cx - x1) * dx + (cy - y1) * dy) / line_len_sq
    margin = 0.1
    is_within_segment = -margin <= t <= 1.0 + margin
    
    a = y2 - y1
    b = x1 - x2
    c = x2 * y1 - x1 * y2
    denom = math.hypot(a, b)
    signed_dist = (a * cx + b * cy + c) / denom if denom != 0 else 0.0
    
    return signed_dist, is_within_segment