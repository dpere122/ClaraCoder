## Base class for everything that can speak.
class_name Animal
extends Node2D

signal spoke(words: String)

const SPEED := 120.0
const TINT := Color("#ff8800")

@export var nickname := "Rex"


## Returns what this animal says.
func speak() -> String:
	return "..."


func say_it() -> void:
	spoke.emit(speak())


#region helpers
func move(delta: float) -> void:
	position.x += SPEED * delta
#endregion
