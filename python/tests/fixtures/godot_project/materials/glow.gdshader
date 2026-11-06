shader_type canvas_item;

// Pulses the sprite's brightness.
uniform float speed : hint_range(0.0, 10.0) = 2.0;

void fragment() {
	COLOR.rgb *= 1.0 + 0.5 * sin(TIME * speed);
}
