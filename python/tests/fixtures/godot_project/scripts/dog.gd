class_name Dog
extends Animal

const Bone := preload("res://scripts/bone.gd")

@onready var tag := $Tag as Label


func speak() -> String:
	var unused_words := "woof"
	return super.speak() + " woof"


func fetch() -> int:
	var bone := Bone.new()
	move(0.5)
	return bone.weight() + GameState.score
